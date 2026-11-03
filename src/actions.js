// Everything the service can DO on WhatsApp: send messages, manage groups, edit the profile.
// Every action goes through one paced queue (human-like gaps), per-kind quotas and an audit log,
// because bursts of automated actions are what gets WhatsApp numbers banned.
import { q } from './db.js';
import { config } from './config.js';
import { bus } from './bus.js';
import { session } from './session.js';
import { ingestMessage, upsertGroup, chatOf } from './ingest.js';

import { HttpError } from './errors.js';
export { HttpError };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * Math.max(0, b - a);

// ---- pacing: one action at a time, with a random pause between actions -----------------------
let chain = Promise.resolve();
let pending = 0;
let lastEnd = 0;

export async function paced(kind, fn) {
  if (pending >= config.writeQueueMax) throw new HttpError(429, 'too many queued actions, slow down');
  pending += 1;
  const run = chain.then(async () => {
    const [lo, hi] = kind === 'group' ? [config.groupGapMinMs, config.groupGapMaxMs] : [config.msgGapMinMs, config.msgGapMaxMs];
    const wait = lastEnd + rand(lo, hi) - Date.now();
    if (wait > 0) await sleep(wait);
    try { return await fn(); } finally { lastEnd = Date.now(); }
  });
  chain = run.catch(() => {});
  try { return await run; } finally { pending -= 1; }
}

// ---- quotas (counted from the audit log, so they survive restarts) ---------------------------
const LIMITS = {
  send: { window: '1 hour', max: () => config.maxSendsPerHour, label: 'messages per hour' },
  group_create: { window: '1 day', max: () => config.maxGroupCreatesPerDay, label: 'new groups per day' },
  member_change: { window: '1 day', max: () => config.maxMemberChangesPerDay, label: 'members added or removed per day' },
};

async function checkQuota(kind, cost = 1) {
  const lim = LIMITS[kind];
  const { rows } = await q(
    `SELECT COALESCE(SUM(cost),0) AS n FROM actions_log WHERE number_id=$2 AND kind=$1 AND ok AND ts > now() - interval '${lim.window}'`, [kind, config.numberId]);
  const used = Number(rows[0].n);
  if (used + cost > lim.max()) {
    throw new HttpError(429, `limit reached: at most ${lim.max()} ${lim.label} (used ${used}). This protects the number from being banned.`, { kind, used, limit: lim.max() });
  }
}

async function log(kind, action, target, summary, ok, error, cost) {
  await q(
    'INSERT INTO actions_log (number_id, kind, action, target, summary, ok, error, cost) VALUES ($8,$1,$2,$3,$4,$5,$6,$7)',
    [kind, action, target || null, summary ? JSON.stringify(summary) : null, ok, error || null, ok ? cost : 0, config.numberId]
  ).catch((e) => console.error('[actions] log failed', e.message));
}

// ---- helpers -----------------------------------------------------------------------------------
export function waError(e) {
  if (e instanceof HttpError) return e;
  const msg = String(e?.message || e);
  const code = e?.output?.statusCode;
  if (code === 403 || /forbidden|not-authorized|not authorized/i.test(msg)) {
    return new HttpError(403, 'WhatsApp refused: the linked number is probably not an admin of this group', { detail: msg });
  }
  if (code === 404 || /item-not-found|not found/i.test(msg)) {
    return new HttpError(404, 'not found on WhatsApp (the group or number does not exist, or the linked number is not in it)', { detail: msg });
  }
  if (/timed out|timeout/i.test(msg)) return new HttpError(504, 'WhatsApp did not answer in time', { detail: msg });
  return new HttpError(502, 'WhatsApp error: ' + msg.slice(0, 200));
}

function sockOrThrow() {
  if (!session.sock || session.state !== 'open') throw new HttpError(503, 'WhatsApp is not connected right now; try again in a moment');
  return session.sock;
}

/** Accept a full JID or a phone number with country code (digits, spaces, + and dashes allowed). */
export function toJid(x) {
  const s = String(x ?? '').trim();
  if (/@(g\.us|s\.whatsapp\.net|lid)$/.test(s)) return s;
  const d = s.replace(/\D/g, '');
  if (d.length < 8 || d.length > 15) throw new HttpError(400, `"${s}" is not a valid phone number (use digits with country code, e.g. 919800000001) or JID`);
  return d + '@s.whatsapp.net';
}

export function toGroupJid(x) {
  const s = String(x ?? '').trim();
  if (!s.endsWith('@g.us')) throw new HttpError(400, 'group id must end with @g.us');
  return s;
}

function list(x, name, { min = 1, max = 256 } = {}) {
  if (!Array.isArray(x) || x.length < min || x.length > max) throw new HttpError(400, `${name} must be a list of ${min} to ${max} items`);
  return x;
}

function text(x, name, max) {
  if (typeof x !== 'string' || !x.trim()) throw new HttpError(400, `${name} (text) is required`);
  if (x.length > max) throw new HttpError(400, `${name} is too long (max ${max} characters)`);
  return x;
}

export function decodeBase64(data, name = 'data_base64') {
  if (typeof data !== 'string' || !data) throw new HttpError(400, `${name} is required`);
  const buf = Buffer.from(data.replace(/^data:[^;]+;base64,/, ''), 'base64');
  if (!buf.length) throw new HttpError(400, `${name} is empty or not valid base64`);
  if (buf.length > config.maxMediaMb * 1024 * 1024) throw new HttpError(413, `file is larger than MAX_MEDIA_MB (${config.maxMediaMb})`);
  return buf;
}

async function verifyNumbers(sock, jids) {
  const phones = jids.filter((j) => j.endsWith('@s.whatsapp.net')).map((j) => j.split('@')[0]);
  if (!phones.length) return jids;
  const res = (await sock.onWhatsApp(...phones)) || [];
  const found = new Map(res.filter((r) => r.exists).map((r) => [r.jid.split('@')[0].split(':')[0], r.jid]));
  const missing = phones.filter((p) => !found.has(p));
  if (missing.length) throw new HttpError(400, 'these numbers are not on WhatsApp: ' + missing.join(', '), { not_on_whatsapp: missing });
  return jids.map((j) => found.get(j.split('@')[0]) || j);
}

/** The message with this uid, as THIS number stored it (another number may hold the primary copy). */
async function messageRef(uid) {
  const { rows } = await q(
    `SELECT o.uid, o.chat_jid, o.id, o.from_me, o.sender_jid, o.text
       FROM messages m JOIN messages o ON o.chat_jid = m.chat_jid AND o.id = m.id AND o.number_id = $2
      WHERE m.uid = $1`, [uid, config.numberId]);
  if (rows[0]) return rows[0];
  const exists = await q('SELECT 1 FROM messages WHERE uid=$1', [uid]);
  throw new HttpError(404, exists.rows[0] ? 'this number has no copy of that message (it is not in that chat)' : 'message not found');
}

const keyOf = (r) => ({
  remoteJid: r.chat_jid, id: r.id, fromMe: r.from_me,
  participant: r.chat_jid.endsWith('@g.us') && r.sender_jid && r.sender_jid !== 'me' ? r.sender_jid : undefined,
});

export async function refreshGroupMeta(sock, jid) {
  const meta = await sock.groupMetadata(jid);
  await upsertGroup(meta);
  bus.emit('group.updated', { number_id: config.numberId, jid });
  return meta;
}

/** Run one action: connected? quota ok? then wait in the queue, execute, audit-log the outcome. */
async function exec({ kind = 'message', quota, cost = 1, action, target, summary }, fn) {
  const sock = sockOrThrow();
  if (quota) await checkQuota(quota, cost);
  return paced(kind, async () => {
    try {
      const out = await fn(sock);
      await log(quota || 'other', action, target, summary, true, null, quota ? cost : 0);
      return out;
    } catch (e) {
      const err = waError(e);
      await log(quota || 'other', action, target, summary, false, err.message, 0);
      throw err;
    }
  });
}

// ---- sending -------------------------------------------------------------------------------------
async function rawSend(sock, jid, content, quoted) {
  const msg = await sock.sendMessage(jid, content, quoted ? { quoted } : {});
  await ingestMessage(sock, msg).catch(() => {});
  let uid = null;
  if (msg?.key?.id) {
    const { rows } = await q('SELECT uid FROM messages WHERE number_id=$3 AND chat_jid=$1 AND id=$2', [chatOf(msg.key), msg.key.id, config.numberId]);
    uid = rows[0] ? Number(rows[0].uid) : null;
  }
  return { id: msg?.key?.id || null, uid, to: jid };
}

async function quotedFor(reply_to_uid) {
  if (!reply_to_uid) return undefined;
  const r = await messageRef(reply_to_uid);
  return { key: keyOf(r), message: { conversation: r.text || '' } };
}

export async function sendContent(to, content, { reply_to_uid, action = 'send', summary } = {}) {
  const jid = toJid(to);
  const quoted = await quotedFor(reply_to_uid);
  return exec({ quota: 'send', action, target: jid, summary }, (sock) => rawSend(sock, jid, content, quoted));
}

export function sendText({ to, text: body, mentions, reply_to_uid }) {
  text(body, 'text', 4096 * 2);
  const content = { text: body };
  if (mentions) content.mentions = list(mentions, 'mentions', { min: 0, max: 100 }).map(toJid);
  return sendContent(to, content, { reply_to_uid, action: 'send_text', summary: { text: body.slice(0, 80) } });
}

export function sendMedia({ to, type, data_base64, mimetype, filename, caption, voice_note, gif, reply_to_uid }) {
  const buf = decodeBase64(data_base64);
  let content;
  switch (type) {
    case 'image': content = { image: buf, caption, mimetype }; break;
    case 'video': content = { video: buf, caption, mimetype, gifPlayback: !!gif }; break;
    case 'audio': content = { audio: buf, ptt: !!voice_note, mimetype: mimetype || (voice_note ? 'audio/ogg; codecs=opus' : 'audio/mpeg') }; break;
    case 'document': content = { document: buf, mimetype: mimetype || 'application/octet-stream', fileName: filename || 'file', caption }; break;
    case 'sticker': content = { sticker: buf }; break;
    default: throw new HttpError(400, 'type must be one of image, video, audio, document, sticker');
  }
  return sendContent(to, content, { reply_to_uid, action: 'send_' + type, summary: { type, bytes: buf.length, filename, caption: caption?.slice(0, 80) } });
}

export function sendLocation({ to, latitude, longitude, name, address, reply_to_uid }) {
  if (typeof latitude !== 'number' || typeof longitude !== 'number') throw new HttpError(400, 'latitude and longitude must be numbers');
  return sendContent(to, { location: { degreesLatitude: latitude, degreesLongitude: longitude, name, address } },
    { reply_to_uid, action: 'send_location', summary: { latitude, longitude, name } });
}

export function sendContacts({ to, contacts, reply_to_uid }) {
  const cs = list(contacts, 'contacts', { max: 10 }).map((c) => {
    const nm = text(c?.name, 'contact name', 100);
    const phone = toJid(c?.phone).split('@')[0];
    return { vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:${nm}\nTEL;type=CELL;type=VOICE;waid=${phone}:+${phone}\nEND:VCARD` };
  });
  return sendContent(to, { contacts: { displayName: cs.length === 1 ? contacts[0].name : `${cs.length} contacts`, contacts: cs } },
    { reply_to_uid, action: 'send_contact', summary: { count: cs.length } });
}

export function sendPoll({ to, question, options, multi }) {
  const name = text(question, 'question', 200);
  const values = list(options, 'options', { min: 2, max: 12 }).map((o) => text(o, 'option', 100));
  return sendContent(to, { poll: { name, values, selectableCount: multi ? values.length : 1 } }, { action: 'send_poll', summary: { question: name } });
}

export async function react(uid, emoji) {
  const r = await messageRef(uid);
  if (typeof emoji !== 'string') throw new HttpError(400, 'emoji (text) is required; use "" to remove a reaction');
  return exec({ quota: 'send', action: 'react', target: r.chat_jid, summary: { uid, emoji } },
    (sock) => rawSend(sock, r.chat_jid, { react: { text: emoji, key: keyOf(r) } }));
}

export async function editMessage(uid, body) {
  const r = await messageRef(uid);
  if (!r.from_me) throw new HttpError(409, 'only messages sent by the linked number can be edited');
  text(body, 'text', 8192);
  const out = await exec({ quota: 'send', action: 'edit', target: r.chat_jid, summary: { uid } },
    (sock) => rawSend(sock, r.chat_jid, { text: body, edit: keyOf(r) }));
  await q('UPDATE messages SET text=$2, edited_at=now() WHERE uid=$1', [r.uid, body]);
  return out;
}

export async function deleteMessage(uid) {
  const r = await messageRef(uid);
  const out = await exec({ quota: 'send', action: 'delete', target: r.chat_jid, summary: { uid } },
    (sock) => rawSend(sock, r.chat_jid, { delete: keyOf(r) }));
  await q('UPDATE messages SET deleted=true WHERE uid=$1', [r.uid]);
  return out;
}

export async function markRead(uid) {
  const r = await messageRef(uid);
  return exec({ action: 'read', target: r.chat_jid, summary: { uid } }, async (sock) => { await sock.readMessages([keyOf(r)]); return { ok: true }; });
}

export function setPresence({ to, state }) {
  if (!['composing', 'recording', 'paused', 'available', 'unavailable'].includes(state)) throw new HttpError(400, 'state must be composing, recording, paused, available or unavailable');
  const jid = toJid(to);
  return exec({ action: 'presence', target: jid, summary: { state } }, async (sock) => { await sock.sendPresenceUpdate(state, jid); return { ok: true }; });
}

export function lookupNumbers(numbers) {
  const phones = list(numbers, 'numbers', { max: 50 }).map((n) => toJid(n).split('@')[0]);
  return exec({ action: 'lookup', summary: { count: phones.length } }, async (sock) => {
    const res = (await sock.onWhatsApp(...phones)) || [];
    const byPhone = new Map(res.map((r) => [r.jid.split('@')[0].split(':')[0], r]));
    return { results: phones.map((p) => ({ phone: p, on_whatsapp: !!byPhone.get(p)?.exists, jid: byPhone.get(p)?.exists ? byPhone.get(p).jid : null })) };
  });
}

// ---- groups --------------------------------------------------------------------------------------
const PARTICIPANT_REASONS = {
  '200': 'ok',
  '401': 'the person has blocked the linked number',
  '403': 'the person\'s privacy settings do not allow being added; they must accept an invite link',
  '408': 'the person recently left this group',
  '409': 'already in the group',
  '500': 'WhatsApp could not process this one',
};

export async function createGroup({ subject, participants, verify = true }) {
  const name = text(subject, 'subject', 100);
  const jids = list(participants, 'participants', { max: 256 }).map(toJid);
  await checkQuota('member_change', jids.length);
  return exec({ kind: 'group', quota: 'group_create', action: 'create_group', target: name, summary: { subject: name, members: jids.length } },
    async (sock) => {
      const members = verify ? await verifyNumbers(sock, jids) : jids;
      const meta = await sock.groupCreate(name, members);
      await upsertGroup(meta);
      bus.emit('group.updated', { number_id: config.numberId, jid: meta.id });
      await log('member_change', 'create_group_members', meta.id, { members: members.length }, true, null, members.length);
      return { jid: meta.id, subject: meta.subject, participants: (meta.participants || []).map((p) => ({ jid: p.phoneNumber || p.id, admin: p.admin || null })) };
    });
}

export async function updateParticipants(groupId, { action, participants, verify = true, invite_fallback = false, invite_message }) {
  const jid = toGroupJid(groupId);
  if (!['add', 'remove', 'promote', 'demote'].includes(action)) throw new HttpError(400, 'action must be add, remove, promote or demote');
  const jids = list(participants, 'participants', { max: 50 }).map(toJid);
  const counted = action === 'add' || action === 'remove';
  if (counted) await checkQuota('member_change', jids.length);
  return exec({ kind: 'group', action: 'participants_' + action, target: jid, summary: { count: jids.length } }, async (sock) => {
    const members = action === 'add' && verify ? await verifyNumbers(sock, jids) : jids;
    const res = await sock.groupParticipantsUpdate(jid, members, action);
    const results = (res || []).map((r) => ({ jid: r.jid, ok: r.status === '200', status: r.status, reason: PARTICIPANT_REASONS[r.status] || 'failed' }));
    const okCount = results.filter((r) => r.ok).length;
    if (counted) await log('member_change', 'participants_' + action, jid, { count: okCount }, true, null, okCount);

    const invites = [];
    if (action === 'add' && invite_fallback) {
      const needInvite = results.filter((r) => r.status === '403' || r.status === '408');
      if (needInvite.length) {
        const code = await sock.groupInviteCode(jid);
        const link = `https://chat.whatsapp.com/${code}`;
        for (const r of needInvite) {
          try {
            await sleep(rand(config.msgGapMinMs, config.msgGapMaxMs));
            await rawSend(sock, r.jid, { text: `${invite_message || 'You are invited to join our WhatsApp group:'} ${link}` });
            r.invite_sent = true;
            invites.push(r.jid);
          } catch (e) { r.invite_sent = false; r.invite_error = e.message; }
        }
        await log('send', 'invite_fallback', jid, { count: invites.length }, true, null, invites.length);
      }
    }
    await refreshGroupMeta(sock, jid).catch(() => {});
    return { group: jid, action, results };
  });
}

const groupAction = (action, groupId, summary, fn) => {
  const jid = toGroupJid(groupId);
  return exec({ kind: 'group', action, target: jid, summary }, async (sock) => {
    const out = await fn(sock, jid);
    await refreshGroupMeta(sock, jid).catch(() => {});
    return out ?? { ok: true };
  });
};

export const setSubject = (g, subject) => {
  const s = text(subject, 'subject', 100);
  return groupAction('group_subject', g, { subject: s }, (sock, jid) => sock.groupUpdateSubject(jid, s));
};

export const setDescription = (g, description) => {
  if (typeof description !== 'string' || description.length > 2048) throw new HttpError(400, 'description (text, max 2048 characters) is required; "" clears it');
  return groupAction('group_description', g, { length: description.length }, (sock, jid) => sock.groupUpdateDescription(jid, description || undefined));
};

export function setGroupSettings(g, b = {}) {
  const todo = [];
  if (b.announce !== undefined) todo.push(['announce', (sock, jid) => sock.groupSettingUpdate(jid, b.announce ? 'announcement' : 'not_announcement')]);
  if (b.locked !== undefined) todo.push(['locked', (sock, jid) => sock.groupSettingUpdate(jid, b.locked ? 'locked' : 'unlocked')]);
  if (b.member_add_mode !== undefined) {
    if (!['admin', 'all'].includes(b.member_add_mode)) throw new HttpError(400, 'member_add_mode must be "admin" or "all"');
    todo.push(['member_add_mode', (sock, jid) => sock.groupMemberAddMode(jid, b.member_add_mode === 'admin' ? 'admin_add' : 'all_member_add')]);
  }
  if (b.join_approval !== undefined) todo.push(['join_approval', (sock, jid) => sock.groupJoinApprovalMode(jid, b.join_approval ? 'on' : 'off')]);
  if (b.ephemeral_seconds !== undefined) {
    if (![0, 86400, 604800, 7776000].includes(b.ephemeral_seconds)) throw new HttpError(400, 'ephemeral_seconds must be 0 (off), 86400, 604800 or 7776000');
    todo.push(['ephemeral', (sock, jid) => sock.groupToggleEphemeral(jid, b.ephemeral_seconds)]);
  }
  if (!todo.length) throw new HttpError(400, 'send at least one of: announce, locked, member_add_mode, join_approval, ephemeral_seconds');
  return groupAction('group_settings', g, { changed: todo.map((t) => t[0]) }, async (sock, jid) => {
    for (const [, fn] of todo) { await fn(sock, jid); await sleep(rand(500, 1500)); }
    return { ok: true, changed: todo.map((t) => t[0]) };
  });
}

export function setGroupPicture(g, data_base64) {
  const buf = decodeBase64(data_base64);
  return groupAction('group_picture', g, { bytes: buf.length }, (sock, jid) => sock.updateProfilePicture(jid, buf));
}
export const removeGroupPicture = (g) => groupAction('group_picture_remove', g, null, (sock, jid) => sock.removeProfilePicture(jid));

export function getInvite(g) {
  const jid = toGroupJid(g);
  return exec({ kind: 'group', action: 'invite_get', target: jid }, async (sock) => {
    const code = await sock.groupInviteCode(jid);
    return { code, link: `https://chat.whatsapp.com/${code}` };
  });
}
export function revokeInvite(g) {
  const jid = toGroupJid(g);
  return exec({ kind: 'group', action: 'invite_revoke', target: jid }, async (sock) => {
    const code = await sock.groupRevokeInvite(jid);
    return { code, link: `https://chat.whatsapp.com/${code}` };
  });
}

export function joinGroup(invite) {
  const code = String(invite ?? '').trim().split('/').pop();
  if (!/^[A-Za-z0-9]{10,40}$/.test(code)) throw new HttpError(400, 'invite must be an invite link or code');
  return exec({ kind: 'group', action: 'group_join', target: code }, async (sock) => {
    const jid = await sock.groupAcceptInvite(code);
    if (jid) await refreshGroupMeta(sock, jid).catch(() => {});
    return { jid };
  });
}

export const leaveGroup = (g) => groupAction('group_leave', g, null, (sock, jid) => sock.groupLeave(jid));

export function refreshGroup(g) {
  const jid = toGroupJid(g);
  return exec({ kind: 'group', action: 'group_refresh', target: jid }, async (sock) => {
    const meta = await refreshGroupMeta(sock, jid);
    return { jid, subject: meta.subject, participants: (meta.participants || []).length };
  });
}

export function joinRequests(g) {
  const jid = toGroupJid(g);
  return exec({ kind: 'group', action: 'join_requests_list', target: jid }, async (sock) => ({ requests: (await sock.groupRequestParticipantsList(jid)) || [] }));
}

export function decideJoinRequests(g, { action, participants }) {
  if (!['approve', 'reject'].includes(action)) throw new HttpError(400, 'action must be approve or reject');
  const jids = list(participants, 'participants', { max: 50 }).map(toJid);
  return groupAction('join_requests_' + action, g, { count: jids.length }, async (sock, jid) => ({ results: await sock.groupRequestParticipantsUpdate(jid, jids, action) }));
}

// ---- the linked number's own profile --------------------------------------------------------------
export function setProfileName(name) {
  const n = text(name, 'name', 25);
  return exec({ action: 'profile_name', summary: { name: n } }, async (sock) => { await sock.updateProfileName(n); return { ok: true }; });
}
export function setProfileStatus(status) {
  const s = text(status, 'status', 139);
  return exec({ action: 'profile_status', summary: { status: s } }, async (sock) => { await sock.updateProfileStatus(s); return { ok: true }; });
}
export function setProfilePicture(data_base64) {
  const buf = decodeBase64(data_base64);
  return exec({ action: 'profile_picture', summary: { bytes: buf.length } }, async (sock) => { await sock.updateProfilePicture(sock.user.id, buf); return { ok: true }; });
}
export function removeProfilePicture() {
  return exec({ action: 'profile_picture_remove' }, async (sock) => { await sock.removeProfilePicture(sock.user.id); return { ok: true }; });
}
