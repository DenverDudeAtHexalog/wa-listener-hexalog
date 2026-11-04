// HTTP routes for everything that changes something on WhatsApp. All need the ADMIN_API_KEY (header only).
// Every route runs on one number. Say which with `number` (an id or phone from GET /api/numbers) in the body or query.
// If you don't, we use: the number that holds the message (message routes), the only connected number that is in
// the group (group routes), or the only connected number.
import express from 'express';
import { config } from './config.js';
import { q } from './db.js';
import { requireAdmin } from './auth.js';
import * as manager from './manager.js';
import { recentActions } from './audit.js';

export const router = express.Router();

// Routes that carry files need a bigger body limit than the rest of the API; they are parsed here, after auth.
const bigJson = express.json({ limit: `${Math.ceil(config.maxMediaMb * 1.4) + 1}mb` });
export const BIG_BODY_ROUTE = /^\/(api\/(send\/media|groups\/[^/]+\/picture|profile\/picture)|portal\/chat\/send-media)\/?$/;

export async function pickNumber(req, { uid, jid }) {
  const sel = req.body?.number ?? req.query.number;
  if (sel !== undefined && sel !== null && sel !== '') return manager.resolve(sel);
  if (uid) {
    const { rows } = await q('SELECT number_id FROM messages WHERE uid=$1', [uid]);
    if (rows[0]) return rows[0].number_id;
  }
  if (typeof jid === 'string' && jid.endsWith('@g.us')) {
    const { rows } = await q('SELECT number_id FROM wa_groups WHERE jid=$1', [jid]);
    const connected = rows.map((r) => r.number_id).filter((id) => manager.get(id).linked);
    if (connected.length === 1) return connected[0];
    if (rows.length === 1) return rows[0].number_id;
  }
  return manager.resolve(undefined);
}

export function fail(res, e) {
  if (e && Number.isInteger(e.status)) return res.status(e.status).json({ ok: false, error: e.message, ...(e.extra || {}) });
  console.error('[writes]', e);
  return res.status(500).json({ ok: false, error: 'internal error' });
}

/** method, path, name of the action in actions.js, how to build its arguments, and how to find the number */
function route(method, path, fn, args, { uid = false, jid = null, mw = [] } = {}) {
  router[method](path, requireAdmin, ...mw, async (req, res) => {
    try {
      const id = await pickNumber(req, { uid: uid ? Number(req.params.uid) : null, jid: jid ? jid(req) : null });
      const out = await manager.call(id, fn, ...args(req));
      res.json({ ok: true, number: id, ...out });
    } catch (e) { fail(res, e); }
  });
}
const body = (req) => req.body || {};
const toOf = (req) => req.body?.to;
const groupOf = (req) => req.params.jid;

// ---- sending messages
route('post', '/send/text', 'sendText', (r) => [body(r)], { jid: toOf });
route('post', '/send/media', 'sendMedia', (r) => [body(r)], { jid: toOf, mw: [bigJson] });
route('post', '/send/location', 'sendLocation', (r) => [body(r)], { jid: toOf });
route('post', '/send/contact', 'sendContacts', (r) => [body(r)], { jid: toOf });
route('post', '/send/poll', 'sendPoll', (r) => [body(r)], { jid: toOf });

// ---- acting on an existing message (by its uid)
route('post', '/messages/:uid/react', 'react', (r) => [Number(r.params.uid), r.body?.emoji], { uid: true });
route('post', '/messages/:uid/edit', 'editMessage', (r) => [Number(r.params.uid), r.body?.text], { uid: true });
route('post', '/messages/:uid/delete', 'deleteMessage', (r) => [Number(r.params.uid)], { uid: true });
route('post', '/messages/:uid/read', 'markRead', (r) => [Number(r.params.uid)], { uid: true });
route('post', '/presence', 'setPresence', (r) => [body(r)], { jid: toOf });
route('post', '/lookup', 'lookupNumbers', (r) => [r.body?.numbers]);

// ---- groups
route('post', '/groups', 'createGroup', (r) => [body(r)]);
route('post', '/groups/join', 'joinGroup', (r) => [r.body?.invite]);
route('post', '/groups/:jid/participants', 'updateParticipants', (r) => [r.params.jid, body(r)], { jid: groupOf });
route('put', '/groups/:jid/subject', 'setSubject', (r) => [r.params.jid, r.body?.subject], { jid: groupOf });
route('put', '/groups/:jid/description', 'setDescription', (r) => [r.params.jid, r.body?.description], { jid: groupOf });
route('put', '/groups/:jid/settings', 'setGroupSettings', (r) => [r.params.jid, body(r)], { jid: groupOf });
route('put', '/groups/:jid/picture', 'setGroupPicture', (r) => [r.params.jid, r.body?.data_base64], { jid: groupOf, mw: [bigJson] });
route('delete', '/groups/:jid/picture', 'removeGroupPicture', (r) => [r.params.jid], { jid: groupOf });
route('get', '/groups/:jid/invite', 'getInvite', (r) => [r.params.jid], { jid: groupOf });
route('post', '/groups/:jid/invite/revoke', 'revokeInvite', (r) => [r.params.jid], { jid: groupOf });
route('post', '/groups/:jid/leave', 'leaveGroup', (r) => [r.params.jid], { jid: groupOf });
route('post', '/groups/:jid/refresh', 'refreshGroup', (r) => [r.params.jid], { jid: groupOf });
route('get', '/groups/:jid/join-requests', 'joinRequests', (r) => [r.params.jid], { jid: groupOf });
route('post', '/groups/:jid/join-requests', 'decideJoinRequests', (r) => [r.params.jid, body(r)], { jid: groupOf });

// ---- the linked number's own profile
route('put', '/profile/name', 'setProfileName', (r) => [r.body?.name]);
route('put', '/profile/status', 'setProfileStatus', (r) => [r.body?.status]);
route('put', '/profile/picture', 'setProfilePicture', (r) => [r.body?.data_base64], { mw: [bigJson] });
route('delete', '/profile/picture', 'removeProfilePicture', () => []);

// ---- audit log of everything done through this API (optionally ?number=)
router.get('/actions', requireAdmin, async (req, res) => {
  try {
    const nid = req.query.number ? manager.resolve(req.query.number) : null;
    res.json({ ok: true, ...(await recentActions(parseInt(req.query.limit, 10) || 100, nid)) });
  } catch (e) { fail(res, e); }
});

