import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { config, assertConfig } from './config.js';
import { migrate, q, pool } from './db.js';
import { bus } from './bus.js';
import * as manager from './manager.js';
import { HttpError } from './errors.js';
import { publicRow } from './ingest.js';
import { router as writesRouter, BIG_BODY_ROUTE } from './writes.js';
import { router as chatRouter, initChat } from './chat.js';
import { router as peopleRouter, loadPeople, loginUser } from './people.js';
import { startWebhookDispatcher, ensureDefaultWebhook, WEBHOOK_EVENTS } from './webhooks.js';
import {
  checkPassword, makeCookie, clearCookie, requirePortal, requirePortalAdmin, requireApi, loginAllowed, recordLogin, OWNER,
} from './auth.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function buildApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  // Small body limit everywhere; the few routes that upload files are parsed (after auth) in writes.js.
  const smallJson = express.json({ limit: '1mb' });
  app.use((req, res, next) => (BIG_BODY_ROUTE.test(req.path) ? next() : smallJson(req, res, next)));

  // ---- Health (no auth, no secrets) ----------------------------------------------------
  app.get('/health', async (_req, res) => {
    try {
      await q('SELECT 1');
      const ns = manager.list();
      const open = ns.filter((n) => n.linked).length;
      res.json({ ok: true, whatsapp: ns.length === 1 ? ns[0].state : `${open}/${ns.length} open`, numbers: { total: ns.length, open } });
    } catch { res.status(503).json({ ok: false }); }
  });

  // ---- Portal --------------------------------------------------------------------------
  app.use('/', express.static(path.join(here, '..', 'public'), { index: 'index.html', extensions: ['html'] }));

  app.post('/portal/login', async (req, res) => {
    const ip = req.ip;
    if (!loginAllowed(ip)) return res.status(429).json({ error: 'too many attempts, wait a minute' });
    const username = String(req.body?.username || '').trim().toLowerCase();
    let who = null;
    if (!username || username === 'owner') { if (checkPassword(req.body?.password)) who = OWNER; }
    else {
      const u = await loginUser(username, req.body?.password).catch(() => null);
      if (u) who = { id: u.id, key: 'u' + u.id, name: u.name, role: u.role };
    }
    recordLogin(ip, !!who);
    if (!who) return res.status(401).json({ error: username && username !== 'owner' ? 'wrong username or password' : 'wrong password' });
    res.setHeader('Set-Cookie', makeCookie(req.secure, who));
    res.json({ ok: true, user: { name: who.name, role: who.role } });
  });
  app.post('/portal/logout', (_req, res) => { res.setHeader('Set-Cookie', clearCookie()); res.json({ ok: true }); });

  app.get('/portal/me', requirePortal, (req, res) => res.json({ ok: true, user: { id: req.me.id, name: req.me.name, role: req.me.role } }));
  const portalNumbers = () => ({ numbers: manager.list({ secrets: true }), max: config.maxNumbers });
  app.get('/portal/numbers', requirePortalAdmin, (_req, res) => res.json(portalNumbers()));
  app.get('/portal/status', requirePortalAdmin, (_req, res) => res.json(portalNumbers()));

  app.get('/portal/events', requirePortalAdmin, (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    const send = () => res.write(`data: ${JSON.stringify(portalNumbers())}\n\n`);
    send();
    bus.on('numbers.changed', send);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => { bus.off('numbers.changed', send); clearInterval(ping); });
  });

  // Portal actions on numbers. Errors from the manager are HttpErrors with a status.
  const portal = (fn) => async (req, res) => {
    try { res.json(await fn(req)); }
    catch (e) {
      if (Number.isInteger(e.status)) return res.status(e.status).json({ error: e.message });
      console.error('[portal]', e); res.status(500).json({ error: e.message });
    }
  };
  const nid = (req) => { const n = Number(req.params.id); if (!Number.isInteger(n)) throw new HttpError(400, 'bad number id'); return n; };
  app.post('/portal/numbers', requirePortalAdmin, portal((req) => manager.addNumber(req.body?.label)));
  app.put('/portal/numbers/:id', requirePortalAdmin, portal((req) => manager.renameNumber(nid(req), req.body?.label)));
  app.delete('/portal/numbers/:id', requirePortalAdmin, portal(async (req) => { await manager.removeNumber(nid(req)); return { ok: true }; }));
  app.post('/portal/numbers/:id/connect', requirePortalAdmin, portal(async (req) => {
    const phone = req.body?.phone ? String(req.body.phone).replace(/\D/g, '') : null;
    if (req.body?.phone && (!phone || phone.length < 8 || phone.length > 15)) {
      throw new HttpError(400, 'phone must include country code, digits only (e.g. 919311855419)');
    }
    await manager.start(nid(req), { phone });
    return manager.get(nid(req), { secrets: true });
  }));
  app.post('/portal/numbers/:id/disconnect', requirePortalAdmin, portal(async (req) => { await manager.stop(nid(req)); return manager.get(nid(req), { secrets: true }); }));
  app.post('/portal/numbers/:id/unlink', requirePortalAdmin, portal(async (req) => { await manager.logout(nid(req)); return manager.get(nid(req), { secrets: true }); }));

  // ---- API (API key or portal session) --------------------------------------------------
  const api = express.Router();
  api.use(requireApi);

  // `number` (id or phone, see /api/numbers) narrows a read to one number. Without it you see all numbers,
  // and a message that two of our numbers both received is shown once.
  const numberOf = (req) => (req.query.number ? manager.resolve(req.query.number) : null);
  const guard = (fn) => async (...args) => {
    const res = args[1];
    try { await fn(...args); }
    catch (e) { if (Number.isInteger(e.status)) return res.status(e.status).json({ error: e.message, ...(e.extra || {}) }); console.error('[api]', e); res.status(500).json({ error: 'internal error' }); }
  };

  api.get('/status', (_req, res) => {
    const ns = manager.list();
    const main = ns.find((n) => n.linked) || ns[0] || {};
    res.json({ state: main.state, linked: !!main.linked, me: main.me, last_error: main.last_error, numbers: ns });
  });

  api.get('/numbers', (_req, res) => { const ns = manager.list(); res.json({ count: ns.length, numbers: ns }); });

  api.get('/groups', guard(async (req, res) => {
    const nid = numberOf(req);
    const search = req.query.search ? `%${req.query.search}%` : null;
    const { rows } = await q(
      `SELECT g.jid,
              (array_agg(g.subject ORDER BY g.updated_at DESC))[1] AS subject,
              (array_agg(g.description ORDER BY g.updated_at DESC))[1] AS description,
              max(g.participant_count) AS participant_count,
              max(g.updated_at) AS updated_at,
              array_agg(g.number_id ORDER BY g.number_id) AS numbers,
              (SELECT max(ts) FROM messages m WHERE m.chat_jid = g.jid AND ($1::int IS NULL AND m.primary_copy OR m.number_id = $1)) AS last_message_at,
              (SELECT count(*) FROM messages m WHERE m.chat_jid = g.jid AND ($1::int IS NULL AND m.primary_copy OR m.number_id = $1)) AS message_count
         FROM wa_groups g
        WHERE ($1::int IS NULL OR g.number_id = $1) AND ($2::text IS NULL OR g.subject ILIKE $2)
        GROUP BY g.jid ORDER BY 2`, [nid, search]);
    res.json({ count: rows.length, groups: rows.map((r) => ({ ...r, message_count: Number(r.message_count) })) });
  }));

  api.get('/groups/:jid', guard(async (req, res) => {
    const nid = numberOf(req);
    const { rows } = await q(
      `SELECT g.*, (SELECT array_agg(number_id ORDER BY number_id) FROM wa_groups x WHERE x.jid = g.jid) AS numbers
         FROM wa_groups g WHERE g.jid = $1 AND ($2::int IS NULL OR g.number_id = $2) ORDER BY g.updated_at DESC LIMIT 1`, [req.params.jid, nid]);
    rows[0] ? res.json(rows[0]) : res.status(404).json({ error: 'group not found' });
  }));

  // Query messages. Cursor-style: pass `after_uid` to get everything newer than what you have.
  const listMessages = guard(async (req, res, chatJid) => {
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const where = []; const p = [];
    const add = (sql, v) => { p.push(v); where.push(sql.replace('?', `$${p.length}`)); };
    const nid = numberOf(req);
    if (nid) add('m.number_id = ?', nid); else where.push('m.primary_copy');
    if (chatJid) add('m.chat_jid = ?', chatJid);
    if (req.query.after_uid) add('m.uid > ?', Number(req.query.after_uid));
    if (req.query.before_uid) add('m.uid < ?', Number(req.query.before_uid));
    if (req.query.since) add('m.ts >= ?', new Date(req.query.since));
    if (req.query.until) add('m.ts <= ?', new Date(req.query.until));
    if (req.query.type) add('m.type = ANY(?)', String(req.query.type).split(','));
    if (req.query.sender) add('m.sender_phone = ?', String(req.query.sender).replace(/\D/g, ''));
    if (req.query.search) add('m.text ILIKE ?', `%${req.query.search}%`);
    const order = req.query.after_uid ? 'ASC' : 'DESC';
    const { rows } = await q(
      `SELECT m.*, g.subject AS group_name FROM messages m LEFT JOIN wa_groups g ON g.jid = m.chat_jid AND g.number_id = m.number_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY m.uid ${order} LIMIT ${limit}`, p);
    const out = rows.map(publicRow);
    if (String(req.query.include || '').split(',').includes('reactions') && out.length) {
      const { rows: rx } = await q(
        `SELECT chat_jid, message_id, emoji, count(*)::int AS n FROM reactions WHERE message_id = ANY($1) AND chat_jid = ANY($2) AND emoji IS NOT NULL AND emoji <> '' GROUP BY 1,2,3`,
        [out.map((m) => m.id), [...new Set(out.map((m) => m.chat_jid))]]);
      for (const m of out) m.reactions = rx.filter((x) => x.chat_jid === m.chat_jid && x.message_id === m.id).map((x) => ({ emoji: x.emoji, count: x.n }));
    }
    res.json({ count: out.length, next_after_uid: out.length ? Math.max(...out.map((m) => m.uid)) : null, messages: out });
  });
  api.get('/groups/:jid/messages', (req, res) => listMessages(req, res, req.params.jid));
  api.get('/messages', (req, res) => listMessages(req, res, null));

  api.get('/messages/:uid', async (req, res) => {
    const { rows } = await q(
      `SELECT m.*, g.subject AS group_name FROM messages m LEFT JOIN wa_groups g ON g.jid = m.chat_jid AND g.number_id = m.number_id WHERE m.uid = $1`, [req.params.uid]);
    if (!rows[0]) return res.status(404).json({ error: 'message not found' });
    const reactions = (await q('SELECT reactor_jid, emoji, ts FROM reactions WHERE chat_jid=$1 AND message_id=$2', [rows[0].chat_jid, rows[0].id])).rows;
    res.json({ ...publicRow(rows[0]), reactions });
  });

  // Attach a transcript (or any text) produced by an external speech-to-text worker.
  api.put('/messages/:uid/transcript', async (req, res) => {
    const text = req.body?.transcript;
    if (typeof text !== 'string') return res.status(400).json({ error: 'transcript (string) required' });
    const { rows } = await q(`UPDATE messages SET transcript=$2 WHERE (chat_jid, id) = (SELECT chat_jid, id FROM messages WHERE uid=$1) RETURNING uid`, [req.params.uid, text]);
    if (!rows[0]) return res.status(404).json({ error: 'message not found' });
    const { rows: [full] } = await q(`SELECT m.*, g.subject AS group_name FROM messages m LEFT JOIN wa_groups g ON g.jid=m.chat_jid AND g.number_id=m.number_id WHERE m.uid=$1`, [req.params.uid]);
    bus.emit('message.updated', publicRow(full));
    res.json({ ok: true });
  });

  api.get('/media/:uid', async (req, res) => {
    const { rows } = await q(
      `SELECT number_id, chat_jid, id, media_path, media_mime, media_filename, media_size, media_ref FROM messages WHERE uid=$1`, [req.params.uid]);
    const m = rows[0];
    if (!m || (!m.media_path && !m.media_ref)) return res.status(404).json({ error: 'no media for this message' });
    const headers = () => {
      if (m.media_mime) res.type(m.media_mime.split(';')[0]);
      if (m.media_filename) res.setHeader('Content-Disposition', `inline; filename="${m.media_filename.replace(/"/g, '')}"`);
    };

    // 1) saved on this server (MEDIA_MODE=store)
    if (m.media_path) {
      const abs = path.resolve(config.dataDir, m.media_path);
      if (abs.startsWith(path.resolve(config.dataDir) + path.sep) && fs.existsSync(abs)) { headers(); return res.sendFile(abs); }
      if (!m.media_ref) return res.status(410).json({ error: 'media file missing on disk' });
    }

    // 2) fetch from WhatsApp now, through the number that received it (or another connected number that has a copy)
    if (m.media_size && Number(m.media_size) > config.maxMediaMb * 1024 * 1024) {
      return res.status(413).json({ error: `file is larger than MAX_MEDIA_MB (${config.maxMediaMb})` });
    }
    const { rows: copies } = await q(
      `SELECT number_id, media_ref FROM messages WHERE chat_jid=$1 AND id=$2 AND media_ref IS NOT NULL ORDER BY (number_id = $3) DESC`,
      [m.chat_jid, m.id, m.number_id]);
    const usable = copies.filter((c) => { try { return manager.get(c.number_id).linked; } catch { return false; } });
    if (!usable.length) return res.status(503).json({ error: 'WhatsApp is not connected right now; try again in a moment' });
    let lastErr;
    for (const c of usable) {
      try {
        const buf = await manager.fetchMediaFor(c.number_id, { ...m, media_ref: c.media_ref });
        headers();
        return res.send(buf);
      } catch (e) { lastErr = e; }
    }
    res.status(410).json({ error: 'this file is no longer available from WhatsApp', detail: String(lastErr?.message || lastErr).slice(0, 200) });
  });

  // Live stream of events (Server-Sent Events). EventSource can't set headers, so ?api_key= is accepted.
  api.get('/stream', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    let only = null;
    try { only = req.query.number ? manager.resolve(req.query.number) : null; } catch (e) { return res.status(e.status || 400).end(); }
    const handlers = WEBHOOK_EVENTS.map((ev) => {
      const h = (data) => { if (only === null || data?.number_id === only) res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`); };
      bus.on(ev, h);
      return [ev, h];
    });
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => { clearInterval(ping); handlers.forEach(([ev, h]) => bus.off(ev, h)); });
  });

  // Webhook management
  api.get('/webhooks', async (_req, res) => {
    const { rows } = await q('SELECT id, url, events, active, created_at FROM webhooks ORDER BY id');
    res.json({ webhooks: rows, available_events: WEBHOOK_EVENTS });
  });
  api.post('/webhooks', async (req, res) => {
    const { url, events = [] } = req.body || {};
    try { const u = new URL(url); if (!/^https?:$/.test(u.protocol)) throw new Error(); }
    catch { return res.status(400).json({ error: 'valid http(s) url required' }); }
    if (!Array.isArray(events) || events.some((e) => !WEBHOOK_EVENTS.includes(e))) {
      return res.status(400).json({ error: 'events must be a subset of ' + WEBHOOK_EVENTS.join(', ') });
    }
    const secret = req.body.secret || crypto.randomBytes(24).toString('hex');
    const { rows } = await q('INSERT INTO webhooks (url, secret, events) VALUES ($1,$2,$3) RETURNING id', [url, secret, events]);
    res.status(201).json({ id: Number(rows[0].id), url, events, secret, note: 'Store this secret; it is used to verify X-Walistener-Signature (HMAC-SHA256 of the raw body).' });
  });
  api.delete('/webhooks/:id', async (req, res) => {
    await q('DELETE FROM webhooks WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  });
  api.get('/webhooks/:id/deliveries', async (req, res) => {
    const { rows } = await q(
      `SELECT id, event, status, attempts, last_error, created_at, delivered_at FROM webhook_deliveries
       WHERE webhook_id=$1 ORDER BY id DESC LIMIT 100`, [req.params.id]);
    res.json({ deliveries: rows });
  });

  app.use('/portal/chat', chatRouter);
  app.use('/portal', peopleRouter);
  app.use('/api', writesRouter); // write actions (admin key); anything it does not handle falls through to the read API
  app.use('/api', api);

  app.use((err, _req, res, _next) => {
    const status = err.status || err.statusCode;
    if (status >= 400 && status < 500) return res.status(status).json({ error: err.type === 'entity.too.large' ? 'request body too large' : 'bad request' });
    console.error('[http]', err);
    res.status(500).json({ error: 'internal error' });
  });
  return app;
}

async function main() {
  assertConfig();
  fs.mkdirSync(config.dataDir, { recursive: true });
  await migrate();
  await loadPeople();
  initChat();
  await ensureDefaultWebhook();
  startWebhookDispatcher();
  const app = buildApp();
  const server = app.listen(config.port, config.host, () =>
    console.log(`[wa-listener] http://${config.host}:${config.port}  (portal at /)`));

  await manager.init(); // connects every saved number (one worker process each)

  const shutdown = async () => {
    console.log('[wa-listener] shutting down');
    await manager.shutdown();
    server.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
