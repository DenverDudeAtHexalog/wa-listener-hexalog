// Team inbox test: people and roles, chat ownership/status/labels/notes, unread, quick replies, replying as a person.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/walistener_test';
process.env.API_KEY = 'read-key';
process.env.ADMIN_API_KEY = 'admin-key';
process.env.PORTAL_PASSWORD = 'owner-pw';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'walt-'));
process.env.PUBLIC_BASE_URL = 'http://localhost';
process.env.WORKER_ENTRY = path.join(here, 'fake-worker.js');
process.env.MSG_GAP_MIN_MS = '0'; process.env.MSG_GAP_MAX_MS = '0';
process.env.MAX_SENDS_PER_HOUR = '200';
process.env.AUTO_CONNECT = 'false';
delete process.env.WORKER_MODE;

const { migrate, q, pool } = await import('../src/db.js');
const { buildApp } = await import('../src/server.js');
const { loadPeople } = await import('../src/people.js');
const { initChat } = await import('../src/chat.js');
const manager = await import('../src/manager.js');

await migrate();
await q('TRUNCATE messages, reactions, wa_groups, webhooks, webhook_deliveries, actions_log, connection_log, numbers, users, chat_state, chat_notes, chat_reads, quick_replies RESTART IDENTITY CASCADE');
await manager.loadNumbers();
await loadPeople();
initChat();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return; await sleep(50); } assert.fail('timed out waiting for ' + what); };

const app = buildApp();
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const base = `http://localhost:${server.address().port}`;
const J = { 'content-type': 'application/json' };
const call = async (method, p, body, headers = J) => {
  const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})), headers: r.headers };
};
const login = async (username, password) => {
  const r = await call('POST', '/portal/login', { username, password });
  return { ...r, h: r.status === 200 ? { cookie: r.headers.get('set-cookie').split(';')[0], ...J } : null };
};

await manager.addNumber('CX Mumbai');
await manager.addNumber('CX Delhi');
await manager.start(1); await manager.start(2);
await until(() => manager.list().every((n) => n.linked), 'numbers connected');

const SHARED = '120363000000000001@g.us', ONLY2 = '120363000000000002@g.us';
const now = () => Math.floor(Date.now() / 1000);
const msg = (chat, id, text) => ({ key: { remoteJid: chat, id, fromMe: false, participant: '919800000001@s.whatsapp.net' }, pushName: 'Customer', messageTimestamp: now(), message: { conversation: text } });
const feed = (num, m) => manager._request(num, { t: 'ingest', msg: m });
const meta = (num, jid, subject) => manager._request(num, { t: 'group', meta: { id: jid, subject, participants: [{ id: '919800000001@s.whatsapp.net' }] } });
await meta(1, SHARED, 'Acme CX'); await meta(2, SHARED, 'Acme CX'); await meta(2, ONLY2, 'Beta CX');

// ---- logins and roles -----------------------------------------------------------------------------------------------
assert.equal((await call('GET', '/portal/chat/chats')).status, 401, 'chat needs a login');
assert.equal((await login('', 'wrong')).status, 401);
const owner = await login('', 'owner-pw');
assert.equal(owner.status, 200);
let r = await call('GET', '/portal/me', undefined, owner.h);
assert.equal(r.body.user.name, 'Owner'); assert.equal(r.body.user.role, 'admin');

r = await call('POST', '/portal/users', { username: 'asha', name: 'Asha', password: 'asha-pass-123' }, owner.h);
assert.equal(r.status, 200); const ashaId = r.body.user.id; assert.equal(r.body.user.role, 'agent'); assert.equal(r.body.user.password_hash, undefined);
assert.equal((await call('POST', '/portal/users', { username: 'asha', name: 'Dup', password: 'asha-pass-123' }, owner.h)).status, 409);
assert.equal((await call('POST', '/portal/users', { username: 'x', name: 'Short', password: 'asha-pass-123' }, owner.h)).status, 400);
assert.equal((await call('POST', '/portal/users', { username: 'weak', name: 'Weak', password: '123' }, owner.h)).status, 400);
assert.equal((await call('POST', '/portal/users', { username: 'owner', name: 'Owner2', password: 'asha-pass-123' }, owner.h)).status, 400);
r = await call('POST', '/portal/users', { username: 'ravi', name: 'Ravi', password: 'ravi-pass-123' }, owner.h);
const raviId = r.body.user.id;

assert.equal((await login('asha', 'nope')).status, 401);
assert.equal((await login('nobody', 'nope-nope-1')).status, 401);
const asha = await login('asha', 'asha-pass-123'); const ravi = await login('ravi', 'ravi-pass-123');
assert.equal(asha.status, 200);
assert.equal((await call('GET', '/portal/me', undefined, asha.h)).body.user.role, 'agent');

assert.equal((await call('GET', '/portal/users', undefined, asha.h)).status, 403, 'agents cannot list or edit people');
assert.equal((await call('POST', '/portal/numbers', { label: 'x' }, asha.h)).status, 403, 'agents cannot manage numbers');
assert.equal((await call('GET', '/portal/numbers', undefined, asha.h)).status, 403, 'agents never see QR codes');
assert.equal((await call('GET', '/api/groups', undefined, asha.h)).status, 200, 'agents can read');
assert.equal((await call('GET', '/api/webhooks', undefined, asha.h)).status, 403, 'agents cannot see webhooks');
assert.equal((await call('POST', '/api/webhooks', { url: 'https://example.com' }, asha.h)).status, 403);
assert.equal((await call('GET', '/portal/users', undefined, owner.h)).body.users.length, 2);

// ---- unread, waiting ------------------------------------------------------------------------------------------------
await feed(1, msg(SHARED, 'C1', 'is my shipment cleared?'));
await feed(1, msg(SHARED, 'C2', 'please reply'));
await feed(2, msg(ONLY2, 'D1', 'hello beta'));
let chats = (await call('GET', '/portal/chat/chats', undefined, asha.h)).body.chats;
const acme = () => chats.find((c) => c.jid === SHARED);
assert.equal(chats.length, 2);
assert.equal(acme().unread, 2); assert.equal(acme().status, 'open'); assert.ok(acme().waiting_since, 'waiting for a reply');
assert.equal(acme().last_text, 'please reply'); assert.equal(acme().assignee_id, null);
assert.equal((await call('POST', `/portal/chat/chats/${encodeURIComponent(SHARED)}/read`, { uid: acme().last_uid }, asha.h)).status, 200);
chats = (await call('GET', '/portal/chat/chats', undefined, asha.h)).body.chats;
assert.equal(acme().unread, 0, 'read for Asha');
chats = (await call('GET', '/portal/chat/chats', undefined, ravi.h)).body.chats;
assert.equal(acme().unread, 2, 'still unread for Ravi: unread is per person');

// ---- status, owner, labels, notes ---------------------------------------------------------------------------------
const stateUrl = `/portal/chat/chats/${encodeURIComponent(SHARED)}/state`;
r = await call('PUT', stateUrl, { status: 'pending', labels: ['customs', 'urgent', 'customs'], assignee_id: raviId }, asha.h);
assert.equal(r.status, 200); assert.equal(r.body.state.status, 'pending'); assert.deepEqual(r.body.state.labels, ['customs', 'urgent']); assert.equal(r.body.state.assignee_name, 'Ravi');
assert.equal((await call('PUT', stateUrl, { status: 'bogus' }, asha.h)).status, 400);
assert.equal((await call('PUT', stateUrl, { assignee_id: 9999 }, asha.h)).status, 400);
assert.equal((await call('PUT', stateUrl, { labels: Array(11).fill('a').map((x, i) => x + i) }, asha.h)).status, 400);
chats = (await call('GET', '/portal/chat/chats', undefined, asha.h)).body.chats;
assert.equal(acme().status, 'pending'); assert.equal(acme().assignee_name, 'Ravi'); assert.deepEqual(acme().labels, ['customs', 'urgent']);
const notesUrl = `/portal/chat/chats/${encodeURIComponent(SHARED)}/notes`;
r = await call('GET', notesUrl, undefined, asha.h);
assert.ok(r.body.notes.some((n) => n.kind === 'event' && /marked pending/.test(n.text) && n.user_name === 'Asha'), 'status change is written into the history');
assert.ok(r.body.notes.some((n) => /assigned this chat to Ravi/.test(n.text)));

r = await call('POST', notesUrl, { text: 'customs says docs are missing' }, asha.h);
assert.equal(r.status, 200); const noteId = r.body.note.id;
assert.equal((await call('POST', notesUrl, { text: '  ' }, asha.h)).status, 400);
assert.equal((await call('DELETE', `/portal/chat/notes/${noteId}`, undefined, ravi.h)).status, 403, 'only the author or an admin can delete a note');
assert.equal((await call('DELETE', `/portal/chat/notes/${noteId}`, undefined, asha.h)).status, 200);
r = await call('POST', notesUrl, { text: 'second note' }, asha.h);
assert.equal((await call('DELETE', `/portal/chat/notes/${r.body.note.id}`, undefined, owner.h)).status, 200, 'admin can delete any note');

// ---- quick replies ----------------------------------------------------------------------------------------------------
r = await call('POST', '/portal/chat/quick', { title: 'Docs missing', body: 'Please share the missing documents.' }, asha.h);
assert.equal(r.status, 200); const qid = r.body.reply.id;
assert.equal((await call('GET', '/portal/chat/quick', undefined, ravi.h)).body.replies.length, 1, 'quick replies are shared');
assert.equal((await call('DELETE', `/portal/chat/quick/${qid}`, undefined, ravi.h)).status, 403);
assert.equal((await call('DELETE', `/portal/chat/quick/${qid}`, undefined, asha.h)).status, 200);

// ---- replying as a person ---------------------------------------------------------------------------------------------
r = await call('POST', '/portal/chat/send', { to: SHARED, text: 'checking now' }, asha.h);
assert.equal(r.status, 400, 'two numbers are in this group: say which');
r = await call('POST', '/portal/chat/send', { to: SHARED, text: 'checking now', number: 1 }, asha.h);
assert.equal(r.status, 200); const sentUid = r.body.uid; assert.ok(sentUid);
assert.equal((await q('SELECT sent_by_name FROM messages WHERE uid=$1', [sentUid])).rows[0].sent_by_name, 'Asha', 'we remember who sent it');
r = await call('GET', `/api/groups/${encodeURIComponent(SHARED)}/messages?include=reactions`, undefined, asha.h);
assert.equal(r.body.messages.find((m) => m.uid === sentUid).sent_by_name, 'Asha');

r = await call('POST', '/portal/chat/send', { to: ONLY2, text: 'hello from the team' }, asha.h);
assert.equal(r.status, 200); assert.equal(r.body.number, 2);
chats = (await call('GET', '/portal/chat/chats', undefined, asha.h)).body.chats;
assert.equal(chats.find((c) => c.jid === ONLY2).assignee_name, 'Asha', 'answering an unowned chat takes it');
assert.equal(chats.find((c) => c.jid === ONLY2).waiting_since, null, 'answered, no longer waiting');

assert.equal((await call('POST', '/portal/chat/edit', { uid: sentUid, text: 'edited' }, ravi.h)).status, 403, 'cannot edit a colleague message');
assert.equal((await call('POST', '/portal/chat/edit', { uid: sentUid, text: 'checking now, one moment' }, asha.h)).status, 200);
const cust = (await q(`SELECT uid FROM messages WHERE id='C1'`)).rows[0].uid;
assert.equal((await call('POST', '/portal/chat/edit', { uid: cust, text: 'x' }, owner.h)).status, 400, 'cannot edit a customer message');
assert.equal((await call('POST', '/portal/chat/react', { uid: cust, emoji: '👍' }, ravi.h)).status, 200);
assert.equal((await call('POST', '/portal/chat/delete', { uid: sentUid }, ravi.h)).status, 403);

r = await call('POST', '/portal/chat/send-media', { to: ONLY2, type: 'image', data_base64: Buffer.from('fake-png').toString('base64'), caption: 'photo', mimetype: 'image/png' }, ravi.h);
assert.equal(r.status, 200); assert.equal(r.body.number, 2);
assert.equal((await call('POST', '/portal/chat/send-media', { to: ONLY2, type: 'image', data_base64: '' }, ravi.h)).status, 400);
const calls2 = (await manager._request(2, { t: 'calls' })).filter(([n]) => n === 'sendMessage').map((c) => Object.keys(c[2])[0]);
assert.ok(calls2.includes('image'), 'the image reached WhatsApp');

// ---- numbers: response time -------------------------------------------------------------------------------------------
r = await call('GET', '/portal/chat/stats?days=7', undefined, asha.h);
assert.equal(r.status, 200); assert.ok(r.body.answered >= 1); assert.ok(r.body.avg_response_minutes !== null);
assert.ok(r.body.by_person.some((p) => p.name === 'Asha' && p.replies >= 1));
assert.ok(r.body.waiting >= 0);

// ---- a customer message reopens a resolved chat ------------------------------------------------------------------------
await call('PUT', stateUrl, { status: 'resolved' }, ravi.h);
assert.equal((await call('GET', '/portal/chat/chats', undefined, asha.h)).body.chats.find((c) => c.jid === SHARED).status, 'resolved');
await feed(1, msg(SHARED, 'C3', 'one more thing'));
await until(async () => (await call('GET', '/portal/chat/chats', undefined, asha.h)).body.chats.find((c) => c.jid === SHARED).status === 'open', 'chat to reopen');
assert.ok((await call('GET', notesUrl, undefined, asha.h)).body.notes.some((n) => n.user_name === 'System' && /marked open/.test(n.text)));

// ---- passwords and switching people off ---------------------------------------------------------------------------------
assert.equal((await call('POST', '/portal/password', { old: 'wrong', new: 'ravi-new-pass-1' }, ravi.h)).status, 403);
assert.equal((await call('POST', '/portal/password', { old: 'ravi-pass-123', new: 'short' }, ravi.h)).status, 400);
assert.equal((await call('POST', '/portal/password', { old: 'ravi-pass-123', new: 'ravi-new-pass-1' }, ravi.h)).status, 200);
assert.equal((await login('ravi', 'ravi-pass-123')).status, 401, 'old password no longer works');
assert.equal((await login('ravi', 'ravi-new-pass-1')).status, 200);
assert.equal((await call('POST', '/portal/password', { old: 'x', new: 'whatever-1234' }, owner.h)).status, 400, 'owner password is set on the server');

assert.equal((await call('PUT', `/portal/users/${ashaId}`, { active: false }, owner.h)).status, 200);
assert.equal((await call('GET', '/portal/me', undefined, asha.h)).status, 401, 'switched-off people are locked out at once');
assert.equal((await login('asha', 'asha-pass-123')).status, 401);
assert.equal((await call('PUT', `/portal/users/${ashaId}`, { active: true, role: 'admin', name: 'Asha K' }, owner.h)).body.user.role, 'admin');
assert.equal((await call('GET', '/portal/me', undefined, asha.h)).body.user.role, 'admin', 'role change applies to the existing session');
assert.equal((await call('GET', '/portal/chat/users', undefined, ravi.h)).body.users.length, 2);

await manager.shutdown();
server.close();
await pool.end();
console.log('ALL TEAM TESTS PASSED');
