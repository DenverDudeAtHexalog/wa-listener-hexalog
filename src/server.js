import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { config, assertConfig } from './config.js';
import { migrate, q, pool } from './db.js';
import { bus } from './bus.js';
import { session } from './session.js';
import { publicRow, fetchMedia } from './ingest.js';
import { startWebhookDispatcher, ensureDefaultWebhook, WEBHOOK_EVENTS } from './webhooks.js';
import {
  checkPassword, makeCookie, clearCookie, requirePortal, requireApi, loginAllowed, recordLogin,
} from './auth.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function buildApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));

  // ---- Health (no auth, no secrets) ----------------------------------------------------
  app.get('/health', async (_req, res) => {
    try { await q('SELECT 1'); res.json({ ok: true, whatsapp: session.state }); }
    catch { res.status(503).json({ ok: false }); }
  });

  // ---- Portal --------------------------------------------------------------------------
  app.use('/', express.static(path.join(here, '..', 'public'), { index: 'index.html' }));

  app.post('/portal/login', (req, res) => {
    const ip = req.ip;
    if (!loginAllowed(ip)) return res.status(429).json({ error: 'too many attempts, wait a minute' });
    const ok = checkPassword(req.body?.password);
    recordLogin(ip, ok);
    if (!ok) return res.status(401).json({ error: 'wrong password' });
    res.setHeader('Set-Cookie', makeCookie(req.secure));
    res.json({ ok: true });
  });
  app.post('/portal/logout', (_req, res) => { res.setHeader('Set-Cookie', clearCookie()); res.json({ ok: true }); });

  app.get('/portal/me', requirePortal, (_req, res) => res.json({ ok: true }));
  app.get('/portal/status', requirePortal, (_req, res) => res.json(session.status()));

  app.get('/portal/events', requirePortal, (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    const send = (s) => res.write(`data: ${JSON.stringify(s)}\n\n`);
    send(session.status());
    bus.on('connection', send);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => { bus.off('connection', send); clearInterval(ping); });
  });

  app.post('/portal/connect', requirePortal, async (req, res) => {
    try {
      const phone = req.body?.phone ? String(req.body.phone).replace(/\D/g, '') : null;
      if (req.body?.phone && (!phone || phone.length < 8 || phone.length > 15)) {
        return res.status(400).json({ error: 'phone must include country code, digits only (e.g. 919311855419)' });
      }
      res.json(await session.start({ phone }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/portal/disconnect', requirePortal, async (_req, res) => { await session.stop(); res.json(session.status()); });
  app.post('/portal/unlink', requirePortal, async (_req, res) => { await session.logout(); res.json(session.status()); });

  // ---- API (API key or portal session) --------------------------------------------------
  const api = express.Router();
  api.use(requireApi);

  api.get('/status', (_req, res) => {
    const s = session.status();
    res.json({ state: s.state, linked: s.linked, me: s.me, last_error: s.last_error });
  });

  api.get('/groups', async (req, res) => {
    const search = req.query.search ? `%${req.query.search}%` : null;
    const { rows } = await q(
      `SELECT g.jid, g.subject, g.description, g.participant_count, g.updated_at,
              (SELECT max(ts) FROM messages m WHERE m.chat_jid = g.jid) AS last_message_at,
              (SELECT count(*) FROM messages m WHERE m.chat_jid = g.jid) AS message_count
       FROM wa_groups g WHERE ($1::text IS NULL OR g.subject ILIKE $1) ORDER BY g.subject`, [search]);
    res.json({ count: rows.length, groups: rows.map((r) => ({ ...r, message_count: Number(r.message_count) })) });
  });

  api.get('/groups/:jid', async (req, res) => {
    const { rows } = await q('SELECT * FROM wa_groups WHERE jid = $1', [req.params.jid]);
    rows[0] ? res.json(rows[0]) : res.status(404).json({ error: 'group not found' });
  });

  // Query messages. Cursor-style: pass `after_uid` to get everything newer than what you have.
  const listMessages = async (req, res, chatJid) => {
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const where = []; const p = [];
    const add = (sql, v) => { p.push(v); where.push(sql.replace('?', `$${p.length}`)); };
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
      `SELECT m.*, g.subject AS group_name FROM messages m LEFT JOIN wa_groups g ON g.jid = m.chat_jid
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY m.uid ${order} LIMIT ${limit}`, p);
    const out = rows.map(publicRow);
    res.json({ count: out.length, next_after_uid: out.length ? Math.max(...out.map((m) => m.uid)) : null, messages: out });
  };
  api.get('/groups/:jid/messages', (req, res) => listMessages(req, res, req.params.jid));
  api.get('/messages', (req, res) => listMessages(req, res, null));

  api.get('/messages/:uid', async (req, res) => {
    const { rows } = await q(
      `SELECT m.*, g.subject AS group_name FROM messages m LEFT JOIN wa_groups g ON g.jid = m.chat_jid WHERE m.uid = $1`, [req.params.uid]);
    if (!rows[0]) return res.status(404).json({ error: 'message not found' });
    const reactions = (await q('SELECT reactor_jid, emoji, ts FROM reactions WHERE chat_jid=$1 AND message_id=$2', [rows[0].chat_jid, rows[0].id])).rows;
    res.json({ ...publicRow(rows[0]), reactions });
  });

  // Attach a transcript (or any text) produced by an external speech-to-text worker.
  api.put('/messages/:uid/transcript', async (req, res) => {
    const text = req.body?.transcript;
    if (typeof text !== 'string') return res.status(400).json({ error: 'transcript (string) required' });
    const { rows } = await q('UPDATE messages SET transcript=$2 WHERE uid=$1 RETURNING uid', [req.params.uid, text]);
    if (!rows[0]) return res.status(404).json({ error: 'message not found' });
    const { rows: [full] } = await q(`SELECT m.*, g.subject AS group_name FROM messages m LEFT JOIN wa_groups g ON g.jid=m.chat_jid WHERE m.uid=$1`, [req.params.uid]);
    bus.emit('message.updated', publicRow(full));
    res.json({ ok: true });
  });

  api.get('/media/:uid', async (req, res) => {
    const { rows } = await q(
      `SELECT chat_jid, id, media_path, media_mime, media_filename, media_size, media_ref FROM messages WHERE uid=$1`, [req.params.uid]);
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

    // 2) fetch from WhatsApp now
    if (m.media_size && Number(m.media_size) > config.maxMediaMb * 1024 * 1024) {
      return res.status(413).json({ error: `file is larger than MAX_MEDIA_MB (${config.maxMediaMb})` });
    }
    if (!session.sock || session.state !== 'open') {
      return res.status(503).json({ error: 'WhatsApp is not connected right now; try again in a moment' });
    }
    try {
      const buf = await fetchMedia(session.sock, m);
      headers();
      res.send(buf);
    } catch (e) {
      res.status(410).json({ error: 'this file is no longer available from WhatsApp', detail: String(e.message || e).slice(0, 200) });
    }
  });

  // Live stream of events (Server-Sent Events). EventSource can't set headers, so ?api_key= is accepted.
  api.get('/stream', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    const handlers = WEBHOOK_EVENTS.map((ev) => {
      const h = (data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
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

  app.use('/api', api);

  app.use((err, _req, res, _next) => {
    console.error('[http]', err);
    res.status(500).json({ error: 'internal error' });
  });
  return app;
}

async function main() {
  assertConfig();
  fs.mkdirSync(config.dataDir, { recursive: true });
  await migrate();
  await ensureDefaultWebhook();
  startWebhookDispatcher();
  const app = buildApp();
  const server = app.listen(config.port, config.host, () =>
    console.log(`[wa-listener] http://${config.host}:${config.port}  (portal at /)`));

  if (config.autoConnect && (await session.hasSavedLogin())) {
    session.start().catch((e) => console.error('[wa] auto-connect failed', e.message));
  }

  const shutdown = async () => {
    console.log('[wa-listener] shutting down');
    await session.stop();
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
