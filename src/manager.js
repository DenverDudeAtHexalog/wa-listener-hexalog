// Runs and supervises every WhatsApp number.
//
// fork mode (default): one worker process per connected number (worker.js). A crash, memory leak or stuck
//   connection in one number cannot affect the others; the manager restarts a crashed worker by itself.
// inline mode (WORKER_MODE=inline): number 1 runs inside this process. Used by the tests.
//
// This module only ever talks to workers through plain messages (see worker-core.js), so it never needs to import
// Baileys itself.
import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, authDirFor } from './config.js';
import { q } from './db.js';
import { bus } from './bus.js';
import { HttpError } from './errors.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WORKER_ENTRY = process.env.WORKER_ENTRY || path.join(here, 'worker.js'); // tests point this at a fake worker
const INLINE = config.workerMode === 'inline';
const RPC_TIMEOUT_MS = 5 * 60_000; // group actions wait in a paced queue, so allow a long time

const rows = new Map();      // id -> { id, label, phone, auto_connect }
const statuses = new Map();  // id -> last status reported by the worker (includes qr / pairing code)
const workers = new Map();   // id -> { child, pending: Map<rid, {resolve, reject, timer}>, ready }
const desired = new Set();   // numbers that should be running (so a crashed worker is restarted)
const restarts = new Map();  // id -> consecutive restart count
const timers = new Map();    // id -> restart timer
let ridCounter = 0;
let stopping = false;

const idleStatus = (id) => ({ number_id: id, state: 'idle', qr: null, pairing_code: null, me: null, last_error: null, linked: false, writes_enabled: !!config.adminApiKey });

// ---- state shared with the API and portal ------------------------------------------------------------------
const hasSavedLogin = (id) => fs.existsSync(path.join(authDirFor(id), 'creds.json'));

function view(id, { secrets }) {
  const r = rows.get(id);
  const st = statuses.get(id) || idleStatus(id);
  const out = {
    id, label: r.label, phone: r.phone || (st.me?.jid ? st.me.jid.split(':')[0].split('@')[0] : null),
    state: st.state, linked: st.state === 'open', me: st.me, last_error: st.last_error, writes_enabled: st.writes_enabled,
  };
  if (secrets) { out.qr = st.qr; out.pairing_code = st.pairing_code; out.has_login = hasSavedLogin(id); }
  return out;
}

/** All numbers. `secrets: true` adds the QR code / pairing code (portal only, never the public API). */
export function list({ secrets = false } = {}) {
  return [...rows.keys()].sort((a, b) => a - b).map((id) => view(id, { secrets }));
}

export function get(id, opts = {}) {
  if (!rows.has(id)) throw new HttpError(404, 'unknown number');
  return view(id, opts);
}

function setStatus(id, st) {
  const prev = statuses.get(id);
  statuses.set(id, { ...st, number_id: id });
  const ph = st.me?.jid ? String(st.me.jid).split(/[:@]/)[0].replace(/\D/g, '') : null;
  if (ph && rows.get(id) && rows.get(id).phone !== ph) rows.get(id).phone = ph;
  bus.emit('numbers.changed', list({ secrets: true }));
  if (!prev || prev.state !== st.state) {
    // the public 'connection' event (webhooks, /api/stream) never carries the QR code
    bus.emit('connection', { number_id: id, state: st.state, linked: st.state === 'open', me: st.me, last_error: st.last_error });
  }
  if (st.state === 'open') restarts.set(id, 0);
}

/** Which number does a request mean? Accepts an id or a phone number. Without one: the only connected number. */
export function resolve(selector, { required = true } = {}) {
  if (selector !== undefined && selector !== null && selector !== '') {
    const s = String(selector).replace(/\D/g, '');
    if (s) {
      if (s.length <= 6 && rows.has(Number(s))) return Number(s);
      const hit = [...rows.values()].find((r) => r.phone && r.phone === s);
      if (hit) return hit.id;
    }
    throw new HttpError(404, `unknown number "${selector}" (use a number id or phone from GET /api/numbers)`, { numbers: list() });
  }
  const open = [...rows.keys()].filter((id) => (statuses.get(id)?.state) === 'open');
  if (open.length === 1) return open[0];
  if (open.length === 0) {
    if (rows.size === 1) return [...rows.keys()][0];
    if (!required) return null;
    throw new HttpError(503, 'no WhatsApp number is connected right now', { numbers: list() });
  }
  if (!required) return null;
  throw new HttpError(400, 'several numbers are connected: add "number" (an id or phone from GET /api/numbers) to say which one to use', { numbers: list() });
}

// ---- number records -----------------------------------------------------------------------------------------
export async function loadNumbers() {
  const { rows: found } = await q('SELECT id, label, phone, auto_connect FROM numbers ORDER BY id');
  rows.clear();
  for (const r of found) {
    rows.set(r.id, r);
    if (!statuses.has(r.id)) statuses.set(r.id, idleStatus(r.id));
  }
}

export async function addNumber(label) {
  const name = String(label || '').trim().slice(0, 60);
  if (!name) throw new HttpError(400, 'label is required (a name for this number, e.g. "CX Mumbai")');
  if (rows.size >= config.maxNumbers) throw new HttpError(409, `limit reached: at most ${config.maxNumbers} numbers (MAX_NUMBERS)`);
  const { rows: [r] } = await q('INSERT INTO numbers (label) VALUES ($1) RETURNING id, label, phone, auto_connect', [name]);
  rows.set(r.id, r);
  statuses.set(r.id, idleStatus(r.id));
  bus.emit('numbers.changed', list({ secrets: true }));
  return get(r.id, { secrets: true });
}

export async function renameNumber(id, label) {
  const name = String(label || '').trim().slice(0, 60);
  if (!rows.has(id)) throw new HttpError(404, 'unknown number');
  if (!name) throw new HttpError(400, 'label is required');
  await q('UPDATE numbers SET label=$2 WHERE id=$1', [id, name]);
  rows.get(id).label = name;
  bus.emit('numbers.changed', list({ secrets: true }));
  return get(id, { secrets: true });
}

export async function removeNumber(id) {
  if (!rows.has(id)) throw new HttpError(404, 'unknown number');
  const st = statuses.get(id);
  if (st?.state !== 'idle' && st?.state !== 'logged_out') throw new HttpError(409, 'unlink or pause this number first');
  if (hasSavedLogin(id)) throw new HttpError(409, 'this number is still linked; use "Unlink number" first');
  const { rows: [n] } = await q('SELECT count(*)::int AS n FROM messages WHERE number_id=$1', [id]);
  if (n.n > 0) throw new HttpError(409, `this number has ${n.n} stored messages and cannot be deleted`);
  await q('DELETE FROM numbers WHERE id=$1', [id]);
  rows.delete(id); statuses.delete(id);
  bus.emit('numbers.changed', list({ secrets: true }));
}

// ---- worker processes ---------------------------------------------------------------------------------------
function spawn(id) {
  const child = fork(WORKER_ENTRY, [], {
    env: { ...process.env, NUMBER_ID: String(id), DB_POOL_MAX: '3', WORKER_MODE: 'fork' },
    execArgv: [`--max-old-space-size=${config.workerMaxMb}`],
    serialization: 'advanced', // lets Buffers (media) travel between processes
  });
  const w = { child, pending: new Map(), ready: false };
  workers.set(id, w);

  child.on('message', (m) => {
    if (!m) return;
    if (m.t === 'ready') w.ready = true;
    else if (m.t === 'state') setStatus(id, m.status);
    else if (m.t === 'event') bus.emit(m.ev, m.data?.number_id == null ? { number_id: id, ...m.data } : m.data);
    else if (m.t === 'reply') {
      const p = w.pending.get(m.rid);
      if (!p) return;
      w.pending.delete(m.rid);
      clearTimeout(p.timer);
      if (m.ok) p.resolve(m.result);
      else p.reject(new HttpError(m.error?.status || 500, m.error?.message || 'worker error', m.error?.extra || {}));
    }
  });

  child.on('exit', (code, signal) => {
    workers.delete(id);
    for (const p of w.pending.values()) { clearTimeout(p.timer); p.reject(new HttpError(503, 'this number restarted while handling the request; try again')); }
    if (stopping) return;
    if (!desired.has(id)) {
      if (statuses.get(id)?.state !== 'logged_out') setStatus(id, { ...idleStatus(id), last_error: statuses.get(id)?.last_error || null });
      return;
    }
    const n = (restarts.get(id) || 0) + 1;
    restarts.set(id, n);
    const delay = Math.min(30_000, 1000 * 2 ** n);
    console.error(`[manager] worker for number ${id} exited (${signal || code}); restarting in ${delay / 1000}s`);
    setStatus(id, { ...idleStatus(id), state: 'reconnecting', last_error: `worker restarted (${signal || 'exit ' + code})` });
    timers.set(id, setTimeout(() => {
      if (!desired.has(id) || stopping) return;
      request(id, { t: 'start' }).catch((e) => console.error(`[manager] restart of number ${id} failed:`, e.message));
    }, delay));
  });
  return w;
}

function request(id, msg, timeoutMs = RPC_TIMEOUT_MS) {
  let w = workers.get(id);
  if (!w) {
    if (!['start'].includes(msg.t)) return Promise.reject(new HttpError(503, 'this number is not running; start it from the portal'));
    w = spawn(id);
  }
  const rid = ++ridCounter;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { w.pending.delete(rid); reject(new HttpError(504, 'the number did not answer in time')); }, timeoutMs);
    w.pending.set(rid, { resolve, reject, timer });
    try { w.child.send({ ...msg, rid }); } catch (e) { w.pending.delete(rid); clearTimeout(timer); reject(new HttpError(503, 'could not reach the number: ' + e.message)); }
  });
}

const kill = (id) => {
  const w = workers.get(id);
  if (!w) return;
  try { w.child.kill('SIGTERM'); } catch { /* already gone */ }
  setTimeout(() => { try { w.child.kill('SIGKILL'); } catch { /* ok */ } }, 5000).unref();
};

// ---- inline mode (tests) -----------------------------------------------------------------------------------
let inlineWorker; // lazy import so fork mode never loads Baileys in the API process
async function inline() {
  if (!inlineWorker) {
    inlineWorker = await import('./worker-core.js');
    const { session } = await import('./session.js');
    bus.on('session.state', (st) => setStatus(config.numberId, st));
    setStatus(config.numberId, session.status());
  }
  return inlineWorker;
}
const inlineGuard = (id) => { if (id !== config.numberId) throw new HttpError(400, `inline mode only runs number ${config.numberId}`); };

// ---- public controls -------------------------------------------------------------------------------------------
export async function start(id, { phone } = {}) {
  if (!rows.has(id)) throw new HttpError(404, 'unknown number');
  desired.add(id);
  clearTimeout(timers.get(id));
  if (INLINE) { inlineGuard(id); const w = await inline(); return w.execute({ t: 'start', phone }); }
  return request(id, { t: 'start', phone: phone ? String(phone).replace(/\D/g, '') : undefined }, 60_000);
}

export async function stop(id) {
  if (!rows.has(id)) throw new HttpError(404, 'unknown number');
  desired.delete(id);
  clearTimeout(timers.get(id));
  if (INLINE) { inlineGuard(id); const w = await inline(); return w.execute({ t: 'stop' }); }
  if (workers.has(id)) { await request(id, { t: 'stop' }, 20_000).catch(() => {}); kill(id); }
  setStatus(id, idleStatus(id));
}

/** Unlink from WhatsApp and delete the saved login. */
export async function logout(id) {
  if (!rows.has(id)) throw new HttpError(404, 'unknown number');
  desired.delete(id);
  clearTimeout(timers.get(id));
  if (INLINE) { inlineGuard(id); const w = await inline(); return w.execute({ t: 'logout' }); }
  if (workers.has(id)) { await request(id, { t: 'logout' }, 30_000).catch(() => {}); kill(id); }
  else fs.rmSync(authDirFor(id), { recursive: true, force: true });
  setStatus(id, { ...idleStatus(id), state: 'logged_out', last_error: 'unlinked from portal' });
}

/** Run one write action (see RPC_ALLOWED in worker-core.js) on a number. */
export async function call(id, fn, ...args) {
  if (!rows.has(id)) throw new HttpError(404, 'unknown number');
  if (INLINE) { inlineGuard(id); const w = await inline(); return w.execute({ t: 'rpc', fn, args }); }
  if ((statuses.get(id)?.state) !== 'open') throw new HttpError(503, 'WhatsApp is not connected right now for this number; try again in a moment');
  return request(id, { t: 'rpc', fn, args });
}

/** Download a file from WhatsApp using a stored message row. Returns a Buffer. */
export async function fetchMediaFor(id, row) {
  if (!rows.has(id)) throw new HttpError(404, 'unknown number');
  if (INLINE) { inlineGuard(id); const w = await inline(); return w.execute({ t: 'media', row }); }
  if ((statuses.get(id)?.state) !== 'open') throw new HttpError(503, 'WhatsApp is not connected right now for this number; try again in a moment');
  const out = await request(id, { t: 'media', row }, 120_000);
  return Buffer.from(out);
}

/** Test hook for the fake workers: send any custom request to a worker. */
export const _request = (id, msg) => request(id, msg);
export const _pid = (id) => workers.get(id)?.child.pid;

// ---- start-up / shut-down --------------------------------------------------------------------------------------
/** Before multi-number support the single login lived directly in data/auth. Move it into data/auth/1. */
export function migrateLegacyAuth() {
  const base = path.join(config.dataDir, 'auth');
  if (!fs.existsSync(path.join(base, 'creds.json'))) return;
  const target = authDirFor(1);
  if (fs.existsSync(target)) return;
  fs.mkdirSync(target, { recursive: true });
  for (const name of fs.readdirSync(base)) {
    if (/^\d+$/.test(name)) continue;
    fs.renameSync(path.join(base, name), path.join(target, name));
  }
  console.log('[manager] moved the existing WhatsApp login to number 1');
}

export async function init() {
  migrateLegacyAuth();
  await loadNumbers();
  if (INLINE) await inline();
  if (!config.autoConnect) return;
  // Connect saved numbers one after another so we don't open many WhatsApp connections in the same second.
  let delay = 0;
  for (const id of rows.keys()) {
    if (!rows.get(id).auto_connect || !hasSavedLogin(id)) continue;
    setTimeout(() => { if (!stopping) start(id).catch((e) => console.error(`[manager] auto-connect of number ${id} failed:`, e.message)); }, delay);
    delay += 1500;
  }
}

export async function shutdown() {
  stopping = true;
  for (const t of timers.values()) clearTimeout(t);
  await Promise.all([...workers.keys()].map(async (id) => { await request(id, { t: 'stop' }, 8000).catch(() => {}); kill(id); }));
  if (INLINE && inlineWorker) { const { session } = await import('./session.js'); await session.stop().catch(() => {}); }
}
