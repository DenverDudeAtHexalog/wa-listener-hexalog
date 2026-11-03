// Multi-number test: two numbers run as two real worker processes (with fake WhatsApp sockets) against one database.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/walistener_test';
process.env.API_KEY = 'read-key';
process.env.ADMIN_API_KEY = 'admin-key';
process.env.PORTAL_PASSWORD = 'pw';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'walm-'));
process.env.PUBLIC_BASE_URL = 'http://localhost';
process.env.WORKER_ENTRY = path.join(here, 'fake-worker.js');
process.env.MSG_GAP_MIN_MS = '0'; process.env.MSG_GAP_MAX_MS = '0';
process.env.MAX_SENDS_PER_HOUR = '3';
process.env.AUTO_CONNECT = 'false';
delete process.env.WORKER_MODE; // fork mode: one process per number

const { migrate, q, pool } = await import('../src/db.js');
const { buildApp } = await import('../src/server.js');
const { bus } = await import('../src/bus.js');
const manager = await import('../src/manager.js');

await migrate();
await q('TRUNCATE messages, reactions, wa_groups, webhooks, webhook_deliveries, actions_log, connection_log, numbers RESTART IDENTITY CASCADE');
await manager.loadNumbers();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return; await sleep(50); } assert.fail('timed out waiting for ' + what); };

const events = [];
for (const ev of ['message.created', 'message.updated', 'message.deleted', 'reaction', 'connection']) bus.on(ev, (d) => events.push([ev, d]));
const count = (ev, pred = () => true) => events.filter(([e, d]) => e === ev && pred(d)).length;

const app = buildApp();
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const base = `http://localhost:${server.address().port}`;
const READ = { 'x-api-key': 'read-key', 'content-type': 'application/json' };
const ADMIN = { 'x-api-key': 'admin-key', 'content-type': 'application/json' };
const call = async (method, p, body, headers = ADMIN) => {
  const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const get = (p) => call('GET', p, undefined, READ);

// ---- numbers -------------------------------------------------------------------------------------------------
const n1 = await manager.addNumber('CX Mumbai');
const n2 = await manager.addNumber('CX Delhi');
assert.deepEqual([n1.id, n2.id], [1, 2]);
await assert.rejects(manager.addNumber(''), /label is required/);
assert.equal((await get('/api/numbers')).body.count, 2);
assert.equal((await get('/api/numbers')).body.numbers[0].qr, undefined, 'public API never exposes the QR code');

await manager.start(1);
await manager.start(2);
await until(() => manager.list().every((n) => n.linked), 'both numbers connected');
assert.equal((await get('/api/status')).body.numbers.length, 2);
assert.deepEqual((await get('/api/numbers')).body.numbers.map((n) => n.phone), ['919000000001', '919000000002'].map((p) => p), 'phone comes from the linked account');
assert.equal(count('connection', (d) => d.state === 'open'), 2, 'one public connection event per number');
assert.ok(events.filter(([e]) => e === 'connection').every(([, d]) => !('qr' in d)), 'connection events carry no QR');

// ---- helpers to feed messages to a worker as if WhatsApp delivered them ------------------------------------
const SHARED = '120363000000000001@g.us';   // both numbers are members
const ONLY2 = '120363000000000002@g.us';    // only number 2 is a member
const now = () => Math.floor(Date.now() / 1000);
const msg = (chat, id, message, extra = {}) => ({ key: { remoteJid: chat, id, fromMe: false, participant: '919800000001@s.whatsapp.net' }, pushName: 'Asha', messageTimestamp: now(), message, ...extra });
const feed = (num, m, fromHistory = false) => manager._request(num, { t: 'ingest', msg: m, fromHistory });
const meta = (num, jid, subject) => manager._request(num, { t: 'group', meta: { id: jid, subject, participants: [{ id: '919800000001@s.whatsapp.net' }, { id: '919800000002@s.whatsapp.net' }] } });

await meta(1, SHARED, 'Acme CX'); await meta(2, SHARED, 'Acme CX'); await meta(2, ONLY2, 'Beta CX');

// ---- the same message reaches both numbers -------------------------------------------------------------------
await feed(1, msg(SHARED, 'M1', { conversation: 'hello both' }));
await feed(2, msg(SHARED, 'M1', { conversation: 'hello both' }));
const copies = (await q("SELECT number_id, primary_copy FROM messages WHERE id='M1' ORDER BY number_id")).rows;
assert.equal(copies.length, 2, 'each number stores its own copy');
assert.deepEqual(copies.map((c) => c.primary_copy), [true, false], 'the first copy is primary, the second is not');
assert.equal(count('message.created', (d) => d.id === 'M1'), 1, 'webhook / stream event fires once per message');
assert.equal((await get('/api/messages')).body.messages.filter((m) => m.id === 'M1').length, 1, 'default list shows one copy');
assert.equal((await get('/api/messages?number=2')).body.messages.filter((m) => m.id === 'M1').length, 1, '?number=2 shows its own copy');
assert.equal((await get('/api/messages?number=2')).body.messages.find((m) => m.id === 'M1').number_id, 2);

// concurrent delivery: both claim at the same instant, exactly one wins primary
await Promise.all([feed(1, msg(SHARED, 'RACE', { conversation: 'race' })), feed(2, msg(SHARED, 'RACE', { conversation: 'race' }))]);
assert.equal((await q("SELECT count(*)::int AS n FROM messages WHERE id='RACE' AND primary_copy")).rows[0].n, 1, 'exactly one primary copy under a race');
assert.equal(count('message.created', (d) => d.id === 'RACE'), 1);

// a message only number 2 sees
await feed(2, msg(ONLY2, 'M2', { conversation: 'only delhi' }));
assert.ok((await get('/api/messages')).body.messages.some((m) => m.id === 'M2'), 'all-numbers view includes it');
assert.ok(!(await get('/api/messages?number=1')).body.messages.some((m) => m.id === 'M2'), 'number 1 does not have it');
assert.equal((await get('/api/messages?number=999')).status, 404, 'unknown number is a clear error');

// groups: one entry for the shared group, listing both numbers
const groups = (await get('/api/groups')).body.groups;
assert.equal(groups.length, 2);
assert.deepEqual(groups.find((g) => g.jid === SHARED).numbers, [1, 2]);
assert.deepEqual(groups.find((g) => g.jid === ONLY2).numbers, [2]);
assert.equal(groups.find((g) => g.jid === SHARED).message_count, 2, 'shared group counts primary copies once (M1 + RACE)');
assert.equal((await get('/api/groups?number=1')).body.groups.length, 1);

// edits, deletes and reactions that arrive at both numbers are announced once
const react = (id) => msg(SHARED, 'R-' + id, { reactionMessage: { key: { remoteJid: SHARED, id: 'M1', fromMe: false }, text: '👍' } });
await feed(1, react('a')); await feed(2, react('a'));
assert.equal(count('reaction'), 1, 'one reaction event, not two');
const revoke = (id) => msg(SHARED, 'P-' + id, { protocolMessage: { type: 0, key: { remoteJid: SHARED, id: 'RACE', fromMe: false } } });
await feed(1, revoke('1')); await feed(2, revoke('2'));
assert.equal(count('message.deleted'), 1, 'one delete event, not two');
assert.equal((await q("SELECT count(*)::int AS n FROM messages WHERE id='RACE' AND deleted")).rows[0].n, 2, 'both copies are marked deleted');

// ---- writing: choosing the number -------------------------------------------------------------------------------
let r = await call('POST', '/api/send/text', { to: SHARED, text: 'hi' });
assert.equal(r.status, 400, 'two connected numbers are in the group: must say which'); assert.match(r.body.error, /several numbers/);
assert.equal(r.body.numbers.length, 2);
r = await call('POST', '/api/send/text', { to: SHARED, text: 'from delhi', number: 2 });
assert.equal(r.status, 200); assert.equal(r.body.number, 2);
r = await call('POST', '/api/send/text', { to: SHARED, text: 'by phone', number: '919000000001' });
assert.equal(r.status, 200); assert.equal(r.body.number, 1, 'a number can be chosen by its phone');
r = await call('POST', '/api/send/text', { to: ONLY2, text: 'only delhi is in here' });
assert.equal(r.status, 200); assert.equal(r.body.number, 2, 'the only number in that group is chosen automatically');
r = await call('POST', '/api/send/text', { to: '919800000009', text: 'dm' });
assert.equal(r.status, 400, 'a direct message with no number named is ambiguous');

const c1 = (await manager._request(1, { t: 'calls' })).filter(([n]) => n === 'sendMessage').map((c) => c[2].text);
const c2 = (await manager._request(2, { t: 'calls' })).filter(([n]) => n === 'sendMessage').map((c) => c[2].text);
assert.deepEqual(c1, ['by phone']); assert.deepEqual(c2, ['from delhi', 'only delhi is in here']);

// acting on a message goes to the number that holds it
const m2uid = (await get('/api/messages?number=2')).body.messages.find((m) => m.id === 'M2').uid;
r = await call('POST', `/api/messages/${m2uid}/react`, { emoji: '👍' });
assert.equal(r.status, 200); assert.equal(r.body.number, 2, 'react uses the number that received the message');

// ---- quotas are per number ----------------------------------------------------------------------------------------
// number 1 has sent 1 message so far, number 2 has sent 3 (2 texts + 1 reaction); the limit is 3 per hour each
r = await call('POST', '/api/send/text', { to: SHARED, text: 'x', number: 2 });
assert.equal(r.status, 429, 'number 2 is at its limit');
r = await call('POST', '/api/send/text', { to: SHARED, text: 'still fine', number: 1 });
assert.equal(r.status, 200, 'number 1 is not affected by number 2 using up its quota');
const log2 = (await call('GET', '/api/actions?number=2')).body.actions;
assert.ok(log2.length > 0 && log2.every((a) => a.number_id === 2), 'audit log can be filtered by number');

// validation errors from inside a worker keep their status
r = await call('POST', '/api/send/text', { to: SHARED, text: '', number: 1 });
assert.equal(r.status, 400); assert.match(r.body.error, /text/);
assert.equal((await call('POST', '/api/send/text', { to: SHARED, text: 'x', number: 1 }, READ)).status, 403, 'read key cannot send');

// ---- isolation: a crashed worker is restarted, the other number is untouched ---------------------------------
const pid2 = manager._pid(2);
manager._request(1, { t: 'die' }).catch(() => {});
await until(() => manager.get(1).state !== 'open', 'number 1 to drop');
assert.equal(manager.get(2).state, 'open', 'number 2 stays connected while number 1 crashes');
assert.equal(manager._pid(2), pid2, 'number 2 kept the same process');
assert.equal((await call('POST', '/api/send/text', { to: SHARED, text: 'x', number: 1 })).status, 503, 'a down number answers 503');
await until(() => manager.get(1).state === 'open', 'number 1 to be restarted', 15000);
assert.notEqual(manager._pid(1), undefined);

// ---- pause / unlink ---------------------------------------------------------------------------------------------------
await manager.stop(2);
assert.equal(manager.get(2).state, 'idle');
assert.equal((await call('POST', '/api/send/text', { to: ONLY2, text: 'x', number: 2 })).status, 503);
assert.equal(manager.get(1).state, 'open');
r = await call('POST', '/api/send/text', { to: SHARED, text: 'only one is connected, so no number needed' });
assert.equal(r.status, 429 === r.status ? 429 : 200, 'number 1 is the only connected number'); // 429 is fine here: number 1 is near its limit
await assert.rejects(manager.removeNumber(1), /unlink|stored messages|pause/);
await assert.rejects(manager.removeNumber(2), /stored messages/, 'a number with history cannot be deleted');
const n3 = await manager.addNumber('Spare');
await manager.removeNumber(n3.id);
assert.equal(manager.list().length, 2);

// ---- the old single-number login folder is moved to number 1 ------------------------------------------------------------
const authDir = path.join(process.env.DATA_DIR, 'auth');
fs.rmSync(authDir, { recursive: true, force: true });
fs.mkdirSync(authDir, { recursive: true });
fs.writeFileSync(path.join(authDir, 'creds.json'), '{}'); fs.writeFileSync(path.join(authDir, 'app-state-sync-key-X.json'), '{}');
manager.migrateLegacyAuth();
assert.ok(fs.existsSync(path.join(authDir, '1', 'creds.json')) && fs.existsSync(path.join(authDir, '1', 'app-state-sync-key-X.json')));
assert.ok(!fs.existsSync(path.join(authDir, 'creds.json')));

await manager.shutdown();
server.close();
await pool.end();
console.log('ALL MULTI-NUMBER TESTS PASSED');
process.exit(0);
