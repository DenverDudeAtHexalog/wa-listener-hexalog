// End-to-end smoke test with synthetic WhatsApp messages. Needs a Postgres reachable via TEST_DATABASE_URL.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/walistener_test';
process.env.API_KEY = 'test-key';
process.env.PORTAL_PASSWORD = 'pw';
process.env.MEDIA_MODE = 'store'; // first half of the test covers store mode; on-demand is tested below
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wal-'));
process.env.PUBLIC_BASE_URL = 'http://localhost';

const { migrate, q, pool } = await import('../src/db.js');
const { buildApp } = await import('../src/server.js');
const { ingestMessage, upsertGroup, _setDownloader } = await import('../src/ingest.js');
const { startWebhookDispatcher, sign } = await import('../src/webhooks.js');

await migrate();
await q('TRUNCATE messages, reactions, wa_groups, webhooks, webhook_deliveries RESTART IDENTITY CASCADE');

const GROUP = '120363000000000001@g.us';
const now = () => Math.floor(Date.now() / 1000);
const mk = (id, message, extra = {}) => ({
  key: { remoteJid: GROUP, id, fromMe: false, participant: '123@lid', participantAlt: '919800000001@s.whatsapp.net' },
  pushName: 'Asha', messageTimestamp: now(), message, ...extra,
});
const fakeSock = {};
_setDownloader(async () => Buffer.from('OggS-fake-audio-bytes'));

// --- webhook receiver -----------------------------------------------------------------------
const received = [];
const hook = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => (body += c));
  req.on('end', () => { received.push({ headers: req.headers, body }); res.end('ok'); });
});
await new Promise((r) => hook.listen(0, r));
const hookUrl = `http://localhost:${hook.address().port}/h`;

const app = buildApp();
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const base = `http://localhost:${server.address().port}`;
const H = { 'x-api-key': 'test-key', 'content-type': 'application/json' };
const get = async (p) => (await fetch(base + p, { headers: H })).json();
const stopDispatcher = startWebhookDispatcher();

// auth
assert.equal((await fetch(base + '/api/groups')).status, 401, 'API requires key');
assert.equal((await fetch(base + '/api/groups', { headers: { 'x-api-key': 'nope' } })).status, 401);
assert.equal((await fetch(base + '/portal/status')).status, 401, 'portal requires login');
const bad = await fetch(base + '/portal/login', { method: 'POST', headers: H, body: JSON.stringify({ password: 'x' }) });
assert.equal(bad.status, 401);
const good = await fetch(base + '/portal/login', { method: 'POST', headers: H, body: JSON.stringify({ password: 'pw' }) });
assert.equal(good.status, 200);
const cookie = good.headers.get('set-cookie').split(';')[0];
assert.equal((await fetch(base + '/portal/status', { headers: { cookie } })).status, 200);
assert.equal((await fetch(base + '/', {})).status, 200, 'portal page served');
assert.equal((await fetch(base + '/docs')).status, 200, 'docs page served publicly');
assert.equal((await fetch(base + '/hexalog.css')).status, 200, 'brand css served');

// register webhook
const wh = await (await fetch(base + '/api/webhooks', { method: 'POST', headers: H, body: JSON.stringify({ url: hookUrl, events: ['message.created', 'message.deleted'] }) })).json();
assert.ok(wh.secret);

await upsertGroup({ id: GROUP, subject: 'Acme Logistics - CX', participants: [{ id: '123@lid', phoneNumber: '919800000001@s.whatsapp.net', admin: 'admin' }] });

// text, voice note, document, image, reply
await ingestMessage(fakeSock, mk('T1', { extendedTextMessage: { text: 'Shipment HX123456 is stuck at customs', contextInfo: { mentionedJid: ['919800000002@s.whatsapp.net'] } } }));
await ingestMessage(fakeSock, mk('A1', { audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true, seconds: 7, fileLength: 21 } }));
await ingestMessage(fakeSock, mk('D1', { documentWithCaptionMessage: { message: { documentMessage: { mimetype: 'application/pdf', fileName: 'invoice.pdf', caption: 'Invoice attached', fileLength: 21 } } } }));
await ingestMessage(fakeSock, mk('I1', { imageMessage: { mimetype: 'image/jpeg', caption: 'damaged box', fileLength: 21 } }));
await ingestMessage(fakeSock, mk('R1', { extendedTextMessage: { text: 'checking', contextInfo: { stanzaId: 'T1' } } }));
// duplicate + status broadcast + direct chat (ignored by default)
await ingestMessage(fakeSock, mk('T1', { conversation: 'dup' }));
await ingestMessage(fakeSock, { key: { remoteJid: 'status@broadcast', id: 'S1' }, message: { conversation: 'status' } });
await ingestMessage(fakeSock, { key: { remoteJid: '919800000009@s.whatsapp.net', id: 'DM1' }, message: { conversation: 'hi' } });

let r = await get(`/api/groups/${encodeURIComponent(GROUP)}/messages?limit=50`);
assert.equal(r.count, 5, 'duplicates/status/DM ignored');
const byId = Object.fromEntries(r.messages.map((m) => [m.id, m]));
assert.equal(byId.T1.text, 'Shipment HX123456 is stuck at customs');
assert.equal(byId.T1.sender_phone, '919800000001', 'LID resolved to phone via participantAlt');
assert.equal(byId.T1.group_name, 'Acme Logistics - CX');
assert.deepEqual(byId.T1.mentions, ['919800000002@s.whatsapp.net']);
assert.equal(byId.A1.type, 'audio'); assert.equal(byId.A1.is_voice_note, true); assert.equal(byId.A1.media.seconds, 7);
assert.equal(byId.D1.type, 'document'); assert.equal(byId.D1.media.filename, 'invoice.pdf'); assert.equal(byId.D1.text, 'Invoice attached');
assert.equal(byId.R1.quoted_id, 'T1');

// media download through API
const audio = await fetch(`${base}/api/media/${byId.A1.uid}`, { headers: H });
assert.equal(audio.status, 200);
assert.equal(audio.headers.get('content-type'), 'audio/ogg');
assert.equal(Buffer.from(await audio.arrayBuffer()).toString(), 'OggS-fake-audio-bytes');
assert.equal((await fetch(`${base}/api/media/${byId.T1.uid}`, { headers: H })).status, 404);
// api_key via query string (for <audio src> / EventSource)
assert.equal((await fetch(`${base}/api/media/${byId.D1.uid}?api_key=test-key`)).status, 200);

// edit, delete, reaction
await ingestMessage(fakeSock, mk('E1', { protocolMessage: { type: 14, key: { id: 'T1' }, editedMessage: { conversation: 'Shipment HX123456 cleared customs' } } }));
await ingestMessage(fakeSock, mk('X1', { protocolMessage: { type: 0, key: { id: 'I1' } } }));
await ingestMessage(fakeSock, mk('RX1', { reactionMessage: { key: { id: 'T1' }, text: '👍' } }));
const t1 = await get(`/api/messages/${byId.T1.uid}`);
assert.equal(t1.text, 'Shipment HX123456 cleared customs'); assert.ok(t1.edited_at);
assert.equal(t1.reactions.length, 1); assert.equal(t1.reactions[0].emoji, '👍');
assert.equal((await get(`/api/messages/${byId.I1.uid}`)).deleted, true);

// transcript write-back
const put = await fetch(`${base}/api/messages/${byId.A1.uid}/transcript`, { method: 'PUT', headers: H, body: JSON.stringify({ transcript: 'Please check my shipment' }) });
assert.equal(put.status, 200);
assert.equal((await get(`/api/messages/${byId.A1.uid}`)).transcript, 'Please check my shipment');

// cursor + filters
const first = await get(`/api/messages?after_uid=${byId.T1.uid}&type=audio,document`);
assert.deepEqual(first.messages.map((m) => m.id), ['A1', 'D1']);
assert.equal((await get('/api/messages?search=customs')).count, 1);
assert.equal((await get('/api/groups')).groups[0].message_count, 5);

// direct chats: off by default (asserted above), and when enabled a LID chat is merged onto the real number
const { config } = await import('../src/config.js');
config.includeDirectChats = true;
await ingestMessage(fakeSock, { key: { remoteJid: '555@lid', remoteJidAlt: '919800000009@s.whatsapp.net', id: 'DM2', fromMe: false }, pushName: 'Customer', messageTimestamp: now(), message: { conversation: 'hello from a DM' } });
await ingestMessage(fakeSock, { key: { remoteJid: '919800000009@s.whatsapp.net', id: 'DM3', fromMe: false }, pushName: 'Customer', messageTimestamp: now(), message: { conversation: 'second DM' } });
config.includeDirectChats = false;
const dm = await get('/api/messages?search=DM');
const dms = dm.messages.filter((m) => m.chat_jid === '919800000009@s.whatsapp.net');
assert.equal(dms.length, 2, 'both DMs land in one chat keyed by the phone number');
assert.equal(dms[0].sender_phone, '919800000009');

// history-sync style message: sender only on msg.participant, no pushName
await ingestMessage(fakeSock, { key: { remoteJid: GROUP, id: 'HS1', fromMe: false }, participant: '919800000001@s.whatsapp.net', messageTimestamp: now(), message: { conversation: 'hist sender' } }, { fromHistory: true });
// sender only as a LID -> phone resolved from stored group participants
await ingestMessage(fakeSock, { key: { remoteJid: GROUP, id: 'HS2', fromMe: false, participant: '123@lid' }, messageTimestamp: now(), message: { imageMessage: { mimetype: 'image/jpeg', fileLength: 5 } } }, { fromHistory: true });
const hs = (await get(`/api/groups/${encodeURIComponent(GROUP)}/messages?search=hist%20sender`)).messages[0];
assert.equal(hs.sender_jid, '919800000001@s.whatsapp.net'); assert.equal(hs.sender_phone, '919800000001');
const hs2 = (await get(`/api/groups/${encodeURIComponent(GROUP)}/messages?type=image`)).messages.find((m) => m.id === 'HS2');
assert.equal(hs2.sender_phone, '919800000001', 'LID resolved via group participants');
assert.ok(hs2.media.url && hs2.media.stored === false, 'history media is fetchable on demand, not stored');

// ---- on-demand mode: nothing saved, file fetched from WhatsApp when opened -------------------------
config.mediaMode = 'ondemand';
const { session } = await import('../src/session.js');
await ingestMessage(fakeSock, mk('OD1', { documentMessage: { mimetype: 'application/pdf', fileName: 'order.pdf', fileLength: 8, directPath: '/v/t62/abc',
  mediaKey: Buffer.from('k'.repeat(32)), fileSha256: Buffer.from('s'.repeat(32)), fileEncSha256: Buffer.from('e'.repeat(32)) } }));
const od = (await get(`/api/groups/${encodeURIComponent(GROUP)}/messages?type=document`)).messages.find((m) => m.id === 'OD1');
assert.ok(od.media.url && od.media.stored === false, 'on-demand: url present, nothing stored');
const dbrow = (await q('SELECT media_path, media_ref FROM messages WHERE uid=$1', [od.uid])).rows[0];
assert.equal(dbrow.media_path, null, 'no file written to disk');
assert.equal(dbrow.media_ref.fields.directPath, '/v/t62/abc');

// not connected -> 503
session.sock = null; session.state = 'idle';
assert.equal((await fetch(`${base}/api/media/${od.uid}`, { headers: H })).status, 503);
// connected -> downloaded from WhatsApp with the stored key
let seen;
_setDownloader(async (m) => { seen = m; return Buffer.from('PDFBYTES'); });
session.sock = fakeSock; session.state = 'open';
const ok = await fetch(`${base}/api/media/${od.uid}`, { headers: H });
assert.equal(ok.status, 200); assert.equal(ok.headers.get('content-type'), 'application/pdf');
assert.equal(Buffer.from(await ok.arrayBuffer()).toString(), 'PDFBYTES');
assert.equal(seen.message.documentMessage.mediaKey.length, 32, 'key rebuilt as bytes');
assert.equal(seen.key.id, 'OD1');
// expired on WhatsApp -> 410 with a clear message
_setDownloader(async () => { throw new Error('Request failed with status code 410'); });
const gone = await fetch(`${base}/api/media/${od.uid}`, { headers: H });
assert.equal(gone.status, 410); assert.match((await gone.json()).error, /no longer available/);
session.sock = null; session.state = 'idle';
_setDownloader(async () => Buffer.from('OggS-fake-audio-bytes'));

// history messages are stored but do not fire webhooks
const before = received.length;
await ingestMessage(fakeSock, mk('H1', { conversation: 'old message' }), { fromHistory: true });
assert.equal((await get(`/api/groups/${encodeURIComponent(GROUP)}/messages?search=old%20message`)).count, 1);

// webhooks delivered, signed, filtered by event
await new Promise((r) => setTimeout(r, 4500));
const events = received.map((x) => JSON.parse(x.body).event);
assert.ok(events.includes('message.created'), 'message.created delivered');
assert.ok(events.includes('message.deleted'), 'message.deleted delivered');
assert.ok(!events.includes('reaction'), 'unsubscribed event not delivered');
assert.equal(received.filter((x) => JSON.parse(x.body).data?.id === 'H1').length, 0, 'history not pushed');
for (const x of received) assert.equal(x.headers['x-walistener-signature'], sign(wh.secret, x.body), 'valid HMAC');
const created = JSON.parse(received.find((x) => JSON.parse(x.body).data?.id === 'A1').body);
assert.equal(created.data.media.url, `http://localhost/api/media/${byId.A1.uid}`);

console.log('ALL SMOKE TESTS PASSED  (' + received.length + ' webhook deliveries)');
stopDispatcher(); hook.close(); server.close(); await pool.end();
process.exit(0);
