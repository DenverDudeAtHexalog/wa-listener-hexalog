// Tests for the write API using a fake WhatsApp socket that records every call.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/walistener_test';
process.env.API_KEY = 'read-key';
process.env.ADMIN_API_KEY = 'admin-key';
process.env.PORTAL_PASSWORD = 'pw';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'walw-'));
process.env.PUBLIC_BASE_URL = 'http://localhost';
process.env.MSG_GAP_MIN_MS = '0'; process.env.MSG_GAP_MAX_MS = '0';
process.env.GROUP_GAP_MIN_MS = '0'; process.env.GROUP_GAP_MAX_MS = '0';

const { migrate, q, pool } = await import('../src/db.js');
const { config } = await import('../src/config.js');
const { buildApp } = await import('../src/server.js');
const { session } = await import('../src/session.js');
const { ingestMessage } = await import('../src/ingest.js');

await migrate();
await q('TRUNCATE messages, reactions, wa_groups, webhooks, webhook_deliveries, actions_log RESTART IDENTITY CASCADE');

// ---- fake socket ------------------------------------------------------------------------------------------
const calls = [];
const rec = (name, impl) => async (...args) => { calls.push([name, ...args]); return impl ? impl(...args) : undefined; };
const NEWGROUP = '120363999999999999@g.us';
const fakeSock = {
  user: { id: '919311855432:1@s.whatsapp.net' },
  onWhatsApp: rec('onWhatsApp', (...phones) => phones.filter((p) => p !== '910000000000').map((p) => ({ jid: p + '@s.whatsapp.net', exists: true }))),
  sendMessage: rec('sendMessage', (jid, content, opts) => ({
    key: { remoteJid: jid, id: 'OUT' + calls.length, fromMe: true, participant: jid.endsWith('@g.us') ? '919311855432@s.whatsapp.net' : undefined },
    messageTimestamp: Math.floor(Date.now() / 1000), message: content.text ? { conversation: content.text } : content.image ? { imageMessage: { mimetype: 'image/png', caption: content.caption, fileLength: content.image.length } } : { conversation: '[' + Object.keys(content)[0] + ']' },
  })),
  groupCreate: rec('groupCreate', (subject, jids) => ({ id: NEWGROUP, subject, participants: jids.map((j) => ({ id: j, admin: null })) })),
  groupMetadata: rec('groupMetadata', (jid) => ({ id: jid, subject: 'Acme CX', participants: [{ id: '919800000001@s.whatsapp.net', admin: 'admin' }] })),
  groupParticipantsUpdate: rec('groupParticipantsUpdate', (jid, jids) => jids.map((j) => ({ status: j.startsWith('919800000003') ? '403' : '200', jid: j }))),
  groupInviteCode: rec('groupInviteCode', () => 'ABCDEFGHIJ1234'),
  groupRevokeInvite: rec('groupRevokeInvite', () => 'NEWCODE12345678'),
  groupAcceptInvite: rec('groupAcceptInvite', () => NEWGROUP),
  groupUpdateSubject: rec('groupUpdateSubject'), groupUpdateDescription: rec('groupUpdateDescription'),
  groupSettingUpdate: rec('groupSettingUpdate'), groupMemberAddMode: rec('groupMemberAddMode'),
  groupJoinApprovalMode: rec('groupJoinApprovalMode'), groupToggleEphemeral: rec('groupToggleEphemeral'),
  groupLeave: rec('groupLeave'), groupRequestParticipantsList: rec('groupRequestParticipantsList', () => [{ jid: '919800000007@s.whatsapp.net' }]),
  groupRequestParticipantsUpdate: rec('groupRequestParticipantsUpdate', (jid, jids) => jids.map((j) => ({ status: '200', jid: j }))),
  updateProfilePicture: rec('updateProfilePicture'), removeProfilePicture: rec('removeProfilePicture'),
  updateProfileName: rec('updateProfileName'), updateProfileStatus: rec('updateProfileStatus'),
  sendPresenceUpdate: rec('sendPresenceUpdate'), readMessages: rec('readMessages'),
};

const app = buildApp();
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const base = `http://localhost:${server.address().port}`;
const ADMIN = { 'x-api-key': 'admin-key', 'content-type': 'application/json' };
const READ = { 'x-api-key': 'read-key', 'content-type': 'application/json' };
const call = async (method, p, body, headers = ADMIN) => {
  const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const last = (name) => [...calls].reverse().find((c) => c[0] === name);
const GROUP = '120363000000000001@g.us';

// ---- access control ------------------------------------------------------------------------------------------
assert.equal((await call('POST', '/api/send/text', { to: '919800000001', text: 'x' }, { 'content-type': 'application/json' })).status, 401, 'no key');
assert.equal((await call('POST', '/api/send/text', { to: '919800000001', text: 'x' }, READ)).status, 403, 'read key cannot write');
assert.equal((await fetch(`${base}/api/send/text?api_key=admin-key`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401, 'admin key in URL is not accepted');
assert.equal((await call('GET', '/api/groups', undefined, ADMIN)).status, 200, 'admin key can also read');
assert.equal((await call('POST', '/api/send/text', { to: '919800000001', text: 'x' })).status, 503, 'not connected -> 503');
session.sock = fakeSock; session.state = 'open';

// ---- sending -----------------------------------------------------------------------------------------------------
let r = await call('POST', '/api/send/text', { to: '+91 98000-00001', text: 'Hello @919800000002', mentions: ['919800000002'] });
assert.equal(r.status, 200); assert.ok(r.body.id);
let c = last('sendMessage');
assert.equal(c[1], '919800000001@s.whatsapp.net', 'phone number normalised to a JID');
assert.deepEqual(c[2].mentions, ['919800000002@s.whatsapp.net']);

assert.equal((await call('POST', '/api/send/text', { to: 'abc', text: 'x' })).status, 400, 'bad number rejected');
assert.equal((await call('POST', '/api/send/text', { to: '919800000001' })).status, 400, 'missing text rejected');

// group send is stored and can be replied to
r = await call('POST', '/api/send/text', { to: GROUP, text: 'Update: shipment cleared' });
assert.equal(r.status, 200); assert.ok(r.body.uid, 'outgoing group message stored');
const sentUid = r.body.uid;
const stored = (await q('SELECT from_me, text FROM messages WHERE uid=$1', [sentUid])).rows[0];
assert.equal(stored.from_me, true); assert.equal(stored.text, 'Update: shipment cleared');

await ingestMessage(fakeSock, { key: { remoteJid: GROUP, id: 'IN1', fromMe: false, participant: '919800000001@s.whatsapp.net' }, pushName: 'Asha', messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: 'Where is my parcel?' } });
const inUid = (await q("SELECT uid FROM messages WHERE id='IN1'")).rows[0].uid;
r = await call('POST', '/api/send/text', { to: GROUP, text: 'On its way', reply_to_uid: Number(inUid) });
assert.equal(r.status, 200);
c = last('sendMessage');
assert.equal(c[3].quoted.key.id, 'IN1'); assert.equal(c[3].quoted.message.conversation, 'Where is my parcel?');
assert.equal(c[3].quoted.key.participant, '919800000001@s.whatsapp.net');

// media
const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
r = await call('POST', '/api/send/media', { to: GROUP, type: 'image', data_base64: png, caption: 'POD photo' });
assert.equal(r.status, 200); c = last('sendMessage');
assert.ok(Buffer.isBuffer(c[2].image)); assert.equal(c[2].caption, 'POD photo');
r = await call('POST', '/api/send/media', { to: GROUP, type: 'audio', voice_note: true, data_base64: png });
assert.equal(last('sendMessage')[2].ptt, true); assert.match(last('sendMessage')[2].mimetype, /opus/);
r = await call('POST', '/api/send/media', { to: GROUP, type: 'document', filename: 'invoice.pdf', mimetype: 'application/pdf', data_base64: png });
assert.equal(last('sendMessage')[2].fileName, 'invoice.pdf');
assert.equal((await call('POST', '/api/send/media', { to: GROUP, type: 'nope', data_base64: png })).status, 400);
assert.equal((await call('POST', '/api/send/media', { to: GROUP, type: 'image', data_base64: '' })).status, 400);
// a >1 MB upload must work on this route (and be rejected elsewhere)
const big = Buffer.alloc(2 * 1024 * 1024, 1).toString('base64');
assert.equal((await call('POST', '/api/send/media', { to: GROUP, type: 'document', data_base64: big })).status, 200, '2 MB upload accepted');
assert.equal((await call('POST', '/api/send/text', { to: GROUP, text: 'x'.repeat(1_200_000) })).status, 413, 'normal routes keep the 1 MB limit');

r = await call('POST', '/api/send/location', { to: GROUP, latitude: 19.07, longitude: 72.87, name: 'Warehouse' });
assert.equal(r.status, 200); assert.equal(last('sendMessage')[2].location.degreesLatitude, 19.07);
r = await call('POST', '/api/send/contact', { to: GROUP, contacts: [{ name: 'Asha', phone: '919800000001' }] });
assert.equal(r.status, 200); assert.match(last('sendMessage')[2].contacts.contacts[0].vcard, /waid=919800000001/);
r = await call('POST', '/api/send/poll', { to: GROUP, question: 'Pickup time?', options: ['10am', '2pm'] });
assert.equal(r.status, 200); assert.equal(last('sendMessage')[2].poll.selectableCount, 1);

// react / edit / delete / read on existing messages
r = await call('POST', `/api/messages/${inUid}/react`, { emoji: '👍' });
assert.equal(r.status, 200); assert.equal(last('sendMessage')[2].react.key.id, 'IN1');
r = await call('POST', `/api/messages/${sentUid}/edit`, { text: 'Update: shipment delivered' });
assert.equal(r.status, 200); assert.equal(last('sendMessage')[2].edit.id, last('sendMessage')[2].edit.id);
assert.equal((await q('SELECT text FROM messages WHERE uid=$1', [sentUid])).rows[0].text, 'Update: shipment delivered');
assert.equal((await call('POST', `/api/messages/${inUid}/edit`, { text: 'nope' })).status, 409, "cannot edit other people's messages");
r = await call('POST', `/api/messages/${sentUid}/delete`);
assert.equal(r.status, 200); assert.equal((await q('SELECT deleted FROM messages WHERE uid=$1', [sentUid])).rows[0].deleted, true);
assert.equal((await call('POST', `/api/messages/${inUid}/read`)).status, 200); assert.ok(last('readMessages'));
assert.equal((await call('POST', '/api/messages/99999/react', { emoji: '👍' })).status, 404);
assert.equal((await call('POST', '/api/presence', { to: GROUP, state: 'composing' })).status, 200);
r = await call('POST', '/api/lookup', { numbers: ['919800000001', '910000000000'] });
assert.deepEqual(r.body.results.map((x) => x.on_whatsapp), [true, false]);

// ---- groups --------------------------------------------------------------------------------------------------------
r = await call('POST', '/api/groups', { subject: 'Acme x Hexalog', participants: ['919800000001', '910000000000'] });
assert.equal(r.status, 400); assert.deepEqual(r.body.not_on_whatsapp, ['910000000000'], 'unknown numbers stop the group being created');
assert.ok(!last('groupCreate'));
r = await call('POST', '/api/groups', { subject: 'Acme x Hexalog', participants: ['919800000001', '919800000002'] });
assert.equal(r.status, 200); assert.equal(r.body.jid, NEWGROUP);
assert.equal(last('groupCreate')[1], 'Acme x Hexalog');
assert.equal((await q('SELECT subject FROM wa_groups WHERE jid=$1', [NEWGROUP])).rows[0].subject, 'Acme x Hexalog');

const enc = encodeURIComponent(GROUP);
r = await call('POST', `/api/groups/${enc}/participants`, { action: 'add', participants: ['919800000004', '919800000003'] });
assert.equal(r.status, 200);
assert.equal(r.body.results.find((x) => x.jid.startsWith('919800000004')).ok, true);
const priv = r.body.results.find((x) => x.jid.startsWith('919800000003'));
assert.equal(priv.status, '403'); assert.match(priv.reason, /privacy/);
assert.ok(!last('sendMessage') || !String(last('sendMessage')[2].text || '').includes('chat.whatsapp.com'), 'no invite sent unless asked');

r = await call('POST', `/api/groups/${enc}/participants`, { action: 'add', participants: ['919800000003'], invite_fallback: true, invite_message: 'Join us:' });
assert.equal(r.body.results[0].invite_sent, true);
assert.equal(last('sendMessage')[1], '919800000003@s.whatsapp.net');
assert.equal(last('sendMessage')[2].text, 'Join us: https://chat.whatsapp.com/ABCDEFGHIJ1234');

r = await call('POST', `/api/groups/${enc}/participants`, { action: 'promote', participants: ['919800000004'] });
assert.equal(r.status, 200); assert.equal(last('groupParticipantsUpdate')[3], 'promote');
r = await call('POST', `/api/groups/${enc}/participants`, { action: 'remove', participants: ['919800000004'] });
assert.equal(last('groupParticipantsUpdate')[3], 'remove');
assert.equal((await call('POST', `/api/groups/${enc}/participants`, { action: 'ban', participants: ['919800000004'] })).status, 400);
assert.equal((await call('POST', '/api/groups/notagroup/participants', { action: 'add', participants: ['919800000004'] })).status, 400);

assert.equal((await call('PUT', `/api/groups/${enc}/subject`, { subject: 'Renamed' })).status, 200); assert.equal(last('groupUpdateSubject')[2], 'Renamed');
assert.equal((await call('PUT', `/api/groups/${enc}/description`, { description: 'Customer updates' })).status, 200);
r = await call('PUT', `/api/groups/${enc}/settings`, { announce: true, locked: true, member_add_mode: 'admin', join_approval: true, ephemeral_seconds: 604800 });
assert.equal(r.status, 200); assert.equal(last('groupSettingUpdate')[2], 'locked'); assert.equal(last('groupMemberAddMode')[2], 'admin_add');
assert.equal(last('groupJoinApprovalMode')[2], 'on'); assert.equal(last('groupToggleEphemeral')[2], 604800);
assert.equal((await call('PUT', `/api/groups/${enc}/settings`, {})).status, 400);
assert.equal((await call('PUT', `/api/groups/${enc}/settings`, { ephemeral_seconds: 5 })).status, 400);
assert.equal((await call('PUT', `/api/groups/${enc}/picture`, { data_base64: png })).status, 200); assert.ok(Buffer.isBuffer(last('updateProfilePicture')[2]));
assert.equal((await call('DELETE', `/api/groups/${enc}/picture`)).status, 200);
r = await call('GET', `/api/groups/${enc}/invite`);
assert.equal(r.body.link, 'https://chat.whatsapp.com/ABCDEFGHIJ1234');
assert.equal((await call('POST', `/api/groups/${enc}/invite/revoke`)).body.code, 'NEWCODE12345678');
assert.equal((await call('POST', '/api/groups/join', { invite: 'https://chat.whatsapp.com/ABCDEFGHIJ1234' })).body.jid, NEWGROUP);
assert.equal((await call('POST', '/api/groups/join', { invite: 'x' })).status, 400);
assert.equal((await call('GET', `/api/groups/${enc}/join-requests`)).body.requests.length, 1);
r = await call('POST', `/api/groups/${enc}/join-requests`, { action: 'approve', participants: ['919800000007'] });
assert.equal(r.status, 200); assert.equal(last('groupRequestParticipantsUpdate')[3], 'approve');
assert.equal((await call('POST', `/api/groups/${enc}/leave`)).status, 200); assert.ok(last('groupLeave'));
assert.equal((await call('POST', `/api/groups/${enc}/refresh`)).status, 200);

// profile
assert.equal((await call('PUT', '/api/profile/name', { name: 'Hexalog CX' })).status, 200); assert.equal(last('updateProfileName')[1], 'Hexalog CX');
assert.equal((await call('PUT', '/api/profile/status', { status: 'We reply 9-6' })).status, 200);
assert.equal((await call('PUT', '/api/profile/picture', { data_base64: png })).status, 200); assert.equal(last('updateProfilePicture')[1], '919311855432:1@s.whatsapp.net');
assert.equal((await call('DELETE', '/api/profile/picture')).status, 200);

// ---- WhatsApp refusals are translated ---------------------------------------------------------------------------------
const orig = fakeSock.groupUpdateSubject;
fakeSock.groupUpdateSubject = async () => { const e = new Error('forbidden'); e.output = { statusCode: 403 }; throw e; };
r = await call('PUT', `/api/groups/${enc}/subject`, { subject: 'Nope' });
assert.equal(r.status, 403); assert.match(r.body.error, /not an admin/);
fakeSock.groupUpdateSubject = orig;

// ---- audit log + quotas --------------------------------------------------------------------------------------------------
const audit = await call('GET', '/api/actions?limit=500');
assert.ok(audit.body.actions.some((a) => a.action === 'create_group' && a.ok));
assert.ok(audit.body.actions.some((a) => a.action === 'group_subject' && !a.ok), 'failures are logged too');
assert.equal((await call('GET', '/api/actions', undefined, READ)).status, 403, 'audit log is admin only');

config.maxSendsPerHour = 1;
r = await call('POST', '/api/send/text', { to: GROUP, text: 'one too many' });
assert.equal(r.status, 429); assert.match(r.body.error, /limit reached/);
config.maxSendsPerHour = 120;
config.maxGroupCreatesPerDay = 1;
assert.equal((await call('POST', '/api/groups', { subject: 'Another', participants: ['919800000001'] })).status, 429, 'group creation is capped per day');
config.maxGroupCreatesPerDay = 10;

// pacing: with a 150 ms gap, three sends must take at least ~300 ms
config.msgGapMinMs = 150; config.msgGapMaxMs = 150;
const t0 = Date.now();
await Promise.all([1, 2, 3].map((i) => call('POST', '/api/send/text', { to: GROUP, text: 'paced ' + i })));
assert.ok(Date.now() - t0 >= 280, 'messages are spaced out, not sent in a burst');

// disabled when no admin key is configured
config.adminApiKey = '';
assert.equal((await call('POST', '/api/send/text', { to: GROUP, text: 'x' })).status, 403);

console.log('ALL WRITE TESTS PASSED  (' + calls.length + ' WhatsApp calls simulated)');
server.close(); await pool.end();
process.exit(0);
