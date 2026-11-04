// The team inbox behind the chat screen: who owns each chat, status, labels, notes, unread counts, quick replies,
// replying (text, files, reactions, edits, deletes) and response-time numbers. Everything here needs a portal login;
// the browser never holds the API or admin keys. Sending still needs ADMIN_API_KEY to be set on the server.
import express from 'express';
import { config } from './config.js';
import { q } from './db.js';
import { bus } from './bus.js';
import { requirePortal } from './auth.js';
import * as manager from './manager.js';
import { HttpError } from './errors.js';
import { pickNumber, fail } from './writes.js';

export const router = express.Router();
const bigJson = express.json({ limit: `${Math.ceil(config.maxMediaMb * 1.4) + 1}mb` });
const STATUSES = ['open', 'pending', 'resolved'];

const wrap = (fn) => async (req, res) => {
  try { res.json(await fn(req)); } catch (e) { fail(res, e); }
};
const clean = (s, max) => String(s ?? '').trim().slice(0, max);
const jidOf = (req) => decodeURIComponent(req.params.jid);

// ---- chat state ------------------------------------------------------------------------------------------------
async function getState(jid) {
  const { rows } = await q(
    `SELECT s.chat_jid, s.status, s.assignee_id, u.name AS assignee_name, s.labels, s.updated_at
       FROM chat_state s LEFT JOIN users u ON u.id = s.assignee_id WHERE s.chat_jid = $1`, [jid]);
  return rows[0] || { chat_jid: jid, status: 'open', assignee_id: null, assignee_name: null, labels: [], updated_at: null };
}

async function addEvent(jid, who, text) {
  const { rows } = await q(`INSERT INTO chat_notes (chat_jid, kind, user_name, text) VALUES ($1,'event',$2,$3) RETURNING *`, [jid, who, text]);
  bus.emit('note.created', rows[0]);
}

/** Change status / owner / labels, write what changed into the chat history, and tell every open screen. */
export async function setState(jid, patch, who) {
  const before = await getState(jid);
  const next = { status: before.status, assignee_id: before.assignee_id, labels: before.labels };
  if (patch.status !== undefined) {
    if (!STATUSES.includes(patch.status)) throw new HttpError(400, 'status must be open, pending or resolved');
    next.status = patch.status;
  }
  if (patch.assignee_id !== undefined) {
    if (patch.assignee_id === null) next.assignee_id = null;
    else {
      const { rows } = await q('SELECT id FROM users WHERE id = $1 AND active', [Number(patch.assignee_id)]);
      if (!rows[0]) throw new HttpError(400, 'that person does not exist or is switched off');
      next.assignee_id = rows[0].id;
    }
  }
  if (patch.labels !== undefined) {
    if (!Array.isArray(patch.labels) || patch.labels.length > 10) throw new HttpError(400, 'labels: up to 10');
    next.labels = [...new Set(patch.labels.map((l) => clean(l, 30)).filter(Boolean))];
  }
  await q(
    `INSERT INTO chat_state (chat_jid, status, assignee_id, labels, updated_at, updated_by) VALUES ($1,$2,$3,$4,now(),$5)
     ON CONFLICT (chat_jid) DO UPDATE SET status=$2, assignee_id=$3, labels=$4, updated_at=now(), updated_by=$5`,
    [jid, next.status, next.assignee_id, next.labels, who]);
  const after = await getState(jid);
  if (before.status !== after.status) await addEvent(jid, who, `marked ${after.status}`);
  if (before.assignee_id !== after.assignee_id) await addEvent(jid, who, after.assignee_id ? `assigned this chat to ${after.assignee_name}` : 'removed the assignee');
  if (before.labels.join('|') !== after.labels.join('|')) await addEvent(jid, who, after.labels.length ? `set labels: ${after.labels.join(', ')}` : 'cleared the labels');
  bus.emit('chat.state', after);
  return after;
}

/** A customer message reopens a resolved chat. */
export function initChat() {
  bus.on('message.created', async (m) => {
    try {
      if (m.from_me) return;
      const s = await getState(m.chat_jid);
      if (s.status === 'resolved') await setState(m.chat_jid, { status: 'open' }, 'System');
    } catch (e) { console.error('[chat] reopen failed', e.message); }
  });
}

// ---- chat list ---------------------------------------------------------------------------------------------------
router.get('/me', requirePortal, (req, res) => res.json({ user: req.me, writes_enabled: !!config.adminApiKey }));

router.get('/users', requirePortal, wrap(async () => ({
  users: (await q('SELECT id, name, role FROM users WHERE active ORDER BY name')).rows,
})));

router.get('/chats', requirePortal, wrap(async (req) => {
  const nid = req.query.number ? manager.resolve(req.query.number) : null;
  const { rows } = await q(
    `SELECT g.jid,
            (array_agg(g.subject ORDER BY g.updated_at DESC))[1] AS subject,
            array_agg(g.number_id ORDER BY g.number_id) AS numbers,
            max(g.participant_count) AS participant_count,
            cs.status, cs.assignee_id, u.name AS assignee_name, cs.labels,
            lm.uid AS last_uid, lm.ts AS last_ts, lm.text AS last_text, lm.type AS last_type,
            lm.from_me AS last_from_me, lm.sender_name AS last_sender, lm.deleted AS last_deleted,
            (SELECT count(*) FROM messages m WHERE m.chat_jid = g.jid AND m.primary_copy AND NOT m.from_me AND NOT m.deleted
                AND m.uid > COALESCE(cr.last_uid, 0)) AS unread,
            CASE WHEN lm.from_me IS FALSE THEN
              (SELECT min(x.ts) FROM messages x WHERE x.chat_jid = g.jid AND x.primary_copy AND NOT x.from_me
                  AND x.uid > COALESCE((SELECT max(o.uid) FROM messages o WHERE o.chat_jid = g.jid AND o.primary_copy AND o.from_me), 0))
            END AS waiting_since
       FROM wa_groups g
       LEFT JOIN chat_state cs ON cs.chat_jid = g.jid
       LEFT JOIN users u ON u.id = cs.assignee_id
       LEFT JOIN chat_reads cr ON cr.user_key = $1 AND cr.chat_jid = g.jid
       LEFT JOIN LATERAL (SELECT * FROM messages m WHERE m.chat_jid = g.jid AND m.primary_copy ORDER BY m.uid DESC LIMIT 1) lm ON true
      WHERE ($2::int IS NULL OR g.number_id = $2)
      GROUP BY g.jid, cs.status, cs.assignee_id, u.name, cs.labels, lm.uid, lm.ts, lm.text, lm.type, lm.from_me, lm.sender_name, lm.deleted, cr.last_uid`,
    [req.me.key, nid]);
  return {
    chats: rows.map((r) => ({
      ...r, status: r.status || 'open', labels: r.labels || [], unread: Number(r.unread), last_uid: r.last_uid == null ? null : Number(r.last_uid),
    })),
  };
}));

router.put('/chats/:jid/state', requirePortal, wrap(async (req) => ({ state: await setState(jidOf(req), req.body || {}, req.me.name) })));

router.post('/chats/:jid/read', requirePortal, wrap(async (req) => {
  const uid = Number(req.body?.uid);
  if (!Number.isFinite(uid)) throw new HttpError(400, 'uid required');
  await q(`INSERT INTO chat_reads (user_key, chat_jid, last_uid) VALUES ($1,$2,$3)
           ON CONFLICT (user_key, chat_jid) DO UPDATE SET last_uid = GREATEST(chat_reads.last_uid, $3)`, [req.me.key, jidOf(req), uid]);
  return { ok: true };
}));

// ---- notes (private to the team, never sent to WhatsApp) --------------------------------------------------------
router.get('/chats/:jid/notes', requirePortal, wrap(async (req) => ({
  notes: (await q('SELECT id, kind, user_name, text, created_at FROM chat_notes WHERE chat_jid = $1 ORDER BY id DESC LIMIT 200', [jidOf(req)])).rows.reverse(),
})));
router.post('/chats/:jid/notes', requirePortal, wrap(async (req) => {
  const text = clean(req.body?.text, 2000);
  if (!text) throw new HttpError(400, 'write something first');
  const { rows } = await q(`INSERT INTO chat_notes (chat_jid, kind, user_name, text) VALUES ($1,'note',$2,$3) RETURNING id, chat_jid, kind, user_name, text, created_at`, [jidOf(req), req.me.name, text]);
  bus.emit('note.created', rows[0]);
  return { note: rows[0] };
}));
router.delete('/notes/:id', requirePortal, wrap(async (req) => {
  const { rows } = await q('SELECT * FROM chat_notes WHERE id = $1 AND kind = $2', [Number(req.params.id), 'note']);
  if (!rows[0]) throw new HttpError(404, 'note not found');
  if (req.me.role !== 'admin' && rows[0].user_name !== req.me.name) throw new HttpError(403, 'you can only delete your own notes');
  await q('DELETE FROM chat_notes WHERE id = $1', [rows[0].id]);
  bus.emit('note.deleted', { id: rows[0].id, chat_jid: rows[0].chat_jid });
  return { ok: true };
}));

// ---- quick replies (shared snippets) ------------------------------------------------------------------------------
router.get('/quick', requirePortal, wrap(async () => ({ replies: (await q('SELECT id, title, body, created_by FROM quick_replies ORDER BY title')).rows })));
router.post('/quick', requirePortal, wrap(async (req) => {
  const title = clean(req.body?.title, 40), body = clean(req.body?.body, 4000);
  if (!title || !body) throw new HttpError(400, 'title and text are both required');
  const { rows } = await q('INSERT INTO quick_replies (title, body, created_by) VALUES ($1,$2,$3) RETURNING id, title, body, created_by', [title, body, req.me.name]);
  bus.emit('quick.changed', {});
  return { reply: rows[0] };
}));
router.delete('/quick/:id', requirePortal, wrap(async (req) => {
  const { rows } = await q('SELECT * FROM quick_replies WHERE id = $1', [Number(req.params.id)]);
  if (!rows[0]) throw new HttpError(404, 'not found');
  if (req.me.role !== 'admin' && rows[0].created_by !== req.me.name) throw new HttpError(403, 'you can only delete your own quick replies');
  await q('DELETE FROM quick_replies WHERE id = $1', [rows[0].id]);
  bus.emit('quick.changed', {});
  return { ok: true };
}));

// ---- replying ----------------------------------------------------------------------------------------------------
function needWrites() {
  if (!config.adminApiKey) throw new HttpError(403, 'sending is disabled: set ADMIN_API_KEY on the server');
}

/** Remember who sent it; the person who answers an unowned chat takes it. */
async function afterSend(me, out) {
  if (!out?.uid) return;
  await q('UPDATE messages SET sent_by_name = $2 WHERE uid = $1', [out.uid, me.name]);
  bus.emit('chat.sent', { uid: out.uid, chat_jid: out.to, sent_by_name: me.name });
  if (me.id) {
    const s = await getState(out.to);
    if (!s.assignee_id) await setState(out.to, { assignee_id: me.id }, me.name).catch(() => {});
  }
}

async function send(req, fn, args, { to, replyUid, track = false }) {
  needWrites();
  const id = await pickNumber(req, { uid: replyUid || null, jid: to });
  const out = await manager.call(id, fn, ...args);
  if (track) await afterSend(req.me, out).catch((e) => console.error('[chat] afterSend', e.message));
  return { ok: true, number: id, ...out };
}

router.post('/send', requirePortal, wrap(async (req) => {
  const b = req.body || {}; const replyUid = b.reply_to_uid ? Number(b.reply_to_uid) : undefined;
  return send(req, 'sendText', [{ to: b.to, text: b.text, reply_to_uid: replyUid }], { to: b.to, replyUid, track: true });
}));

router.post('/send-media', requirePortal, bigJson, wrap(async (req) => {
  const b = req.body || {}; const replyUid = b.reply_to_uid ? Number(b.reply_to_uid) : undefined;
  const { type, data_base64, mimetype, filename, caption, voice_note } = b;
  return send(req, 'sendMedia', [{ to: b.to, type, data_base64, mimetype, filename, caption, voice_note, reply_to_uid: replyUid }], { to: b.to, replyUid, track: true });
}));

async function ownMessage(req) {
  const uid = Number(req.body?.uid);
  const { rows } = await q('SELECT uid, from_me, sent_by_name FROM messages WHERE uid = $1', [uid]);
  if (!rows[0]) throw new HttpError(404, 'message not found');
  return rows[0];
}

router.post('/react', requirePortal, wrap(async (req) => {
  const m = await ownMessage(req);
  return send(req, 'react', [Number(m.uid), req.body?.emoji ?? ''], { to: undefined, replyUid: Number(m.uid) });
}));

router.post('/edit', requirePortal, wrap(async (req) => {
  const m = await ownMessage(req);
  if (!m.from_me) throw new HttpError(400, 'you can only edit messages we sent');
  if (req.me.role !== 'admin' && m.sent_by_name !== req.me.name) throw new HttpError(403, 'you can only edit your own messages');
  return send(req, 'editMessage', [Number(m.uid), req.body?.text], { to: undefined, replyUid: Number(m.uid) });
}));

router.post('/delete', requirePortal, wrap(async (req) => {
  const m = await ownMessage(req);
  if (!m.from_me) throw new HttpError(400, 'you can only delete messages we sent');
  if (req.me.role !== 'admin' && m.sent_by_name !== req.me.name) throw new HttpError(403, 'you can only delete your own messages');
  return send(req, 'deleteMessage', [Number(m.uid)], { to: undefined, replyUid: Number(m.uid) });
}));

// ---- response times ----------------------------------------------------------------------------------------------
router.get('/stats', requirePortal, wrap(async (req) => {
  const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 7));
  const { rows } = await q(
    `SELECT chat_jid, ts, from_me, sent_by_name FROM messages
      WHERE primary_copy AND NOT deleted AND ts > now() - ($1 || ' days')::interval ORDER BY chat_jid, ts LIMIT 100000`, [String(days)]);
  const times = []; const byAgent = new Map(); let chat = null; let since = null;
  for (const r of rows) {
    if (r.chat_jid !== chat) { chat = r.chat_jid; since = null; }
    const t = new Date(r.ts).getTime();
    if (!r.from_me) { if (since === null) since = t; continue; }
    const name = r.sent_by_name || 'Phone / API';
    const a = byAgent.get(name) || { name, replies: 0, waits: [] }; a.replies++;
    if (since !== null) { const w = (t - since) / 60000; times.push(w); a.waits.push(w); since = null; }
    byAgent.set(name, a);
  }
  const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
  const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const round = (x) => (x == null ? null : Math.round(x * 10) / 10);
  const { rows: [w] } = await q(
    `SELECT count(*)::int AS waiting, extract(epoch FROM now() - min(since))::int AS oldest_s FROM (
       SELECT l.chat_jid, (SELECT min(x.ts) FROM messages x WHERE x.chat_jid = l.chat_jid AND x.primary_copy AND NOT x.from_me
                 AND x.uid > COALESCE((SELECT max(o.uid) FROM messages o WHERE o.chat_jid = l.chat_jid AND o.primary_copy AND o.from_me), 0)) AS since
         FROM (SELECT DISTINCT ON (chat_jid) chat_jid, from_me FROM messages WHERE primary_copy AND NOT deleted ORDER BY chat_jid, uid DESC) l
         LEFT JOIN chat_state cs ON cs.chat_jid = l.chat_jid
        WHERE NOT l.from_me AND COALESCE(cs.status, 'open') <> 'resolved') z`);
  return {
    days, waiting: w.waiting, oldest_waiting_minutes: w.oldest_s == null ? null : Math.round(w.oldest_s / 60),
    answered: times.length, avg_response_minutes: round(avg(times)), median_response_minutes: round(median(times)),
    by_person: [...byAgent.values()].map((a) => ({ name: a.name, replies: a.replies, avg_response_minutes: round(avg(a.waits)) })).sort((a, b) => b.replies - a.replies),
  };
}));

// ---- live updates for the team ----------------------------------------------------------------------------------
const LIVE = ['chat.state', 'chat.sent', 'note.created', 'note.deleted', 'quick.changed'];
router.get('/stream', requirePortal, (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const hs = LIVE.map((ev) => { const h = (d) => res.write(`event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`); bus.on(ev, h); return [ev, h]; });
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => { clearInterval(ping); hs.forEach(([ev, h]) => bus.off(ev, h)); });
});
