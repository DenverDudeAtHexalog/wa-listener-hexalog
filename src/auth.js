import crypto from 'node:crypto';
import { config } from './config.js';

const safeEq = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};

const hmac = (s) => crypto.createHmac('sha256', config.sessionSecret).update(s).digest('hex');
const COOKIE = 'wl_session';
const TTL_MS = 12 * 60 * 60 * 1000;

export function checkPassword(p) { return safeEq(p || '', config.portalPassword); }

// ---- people ------------------------------------------------------------------------------------------------------
// The portal password is the owner login. Everyone else has a username and their own password.
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync(String(pw), salt, 32).toString('hex')}`;
}
export function verifyPassword(pw, stored) {
  const [alg, salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  return safeEq(crypto.scryptSync(String(pw), salt, 32).toString('hex'), hash);
}

// Active people, kept in memory so a deactivated person is locked out immediately.
const people = new Map(); // id -> { id, name, role, active }
export function setPeople(rows) { people.clear(); for (const r of rows) people.set(Number(r.id), { id: Number(r.id), name: r.name, role: r.role, active: r.active }); }
export const OWNER = { id: 0, key: 'o', name: 'Owner', role: 'admin' };

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

export function makeCookie(secure = false, who = OWNER) {
  const payload = b64({ u: who.id, exp: Date.now() + TTL_MS });
  return `${COOKIE}=${payload}.${hmac(payload)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${TTL_MS / 1000}${secure ? '; Secure' : ''}`;
}
export const clearCookie = () => `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;

function readCookie(req) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=');
  }
  return null;
}

/** Who is signed in to the portal: { id, key, name, role } or null. */
export function sessionOf(req) {
  const c = readCookie(req);
  if (!c) return null;
  const [payload, sig] = c.split('.');
  if (!payload || !sig || !safeEq(sig, hmac(payload))) return null;
  let d; try { d = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { return null; }
  if (!d || Number(d.exp) < Date.now()) return null;
  if (Number(d.u) === 0) return OWNER;
  const p = people.get(Number(d.u));
  return p && p.active ? { id: p.id, key: 'u' + p.id, name: p.name, role: p.role } : null;
}
export const hasPortalSession = (req) => !!sessionOf(req);

function presentedKeys(req) {
  const header = req.headers['x-api-key'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || '';
  return { header, query: req.query.api_key || '' };
}

/** Read access: the API key (header or ?api_key=) or the admin key (header only). */
export function hasApiKey(req) {
  const { header, query } = presentedKeys(req);
  if (header && (safeEq(header, config.apiKey) || (config.adminApiKey && safeEq(header, config.adminApiKey)))) return true;
  return !!query && safeEq(query, config.apiKey);
}

/** Write access: the admin key, sent in a header only (never in a URL, where it would end up in logs). */
export function hasAdminKey(req) {
  const { header } = presentedKeys(req);
  return !!config.adminApiKey && !!header && safeEq(header, config.adminApiKey);
}

export const requireAdmin = (req, res, next) => {
  if (!config.adminApiKey) return res.status(403).json({ error: 'writing is disabled: set ADMIN_API_KEY on the server' });
  if (hasAdminKey(req)) return next();
  const { header } = presentedKeys(req);
  return res.status(header ? 403 : 401).json({ error: header ? 'this action needs the admin API key' : 'missing admin API key' });
};

export const requirePortal = (req, res, next) => {
  const me = sessionOf(req);
  if (!me) return res.status(401).json({ error: 'login required' });
  req.me = me; next();
};
export const requirePortalAdmin = (req, res, next) => {
  const me = sessionOf(req);
  if (!me) return res.status(401).json({ error: 'login required' });
  if (me.role !== 'admin') return res.status(403).json({ error: 'only an admin can do this' });
  req.me = me; next();
};

// API: a key, or a signed-in person. People with the agent role can only read, and cannot touch webhooks.
export const requireApi = (req, res, next) => {
  if (hasApiKey(req)) return next();
  const me = sessionOf(req);
  if (!me) return res.status(401).json({ error: 'invalid or missing API key' });
  if (me.role !== 'admin' && (req.method !== 'GET' || /^\/webhooks/.test(req.path) || /^\/actions/.test(req.path))) {
    return res.status(403).json({ error: 'agents can read, but not change webhooks or settings' });
  }
  req.me = me; next();
};

// Tiny in-memory brute-force limiter for the login endpoint
const fails = new Map();
export function loginAllowed(ip) {
  const f = fails.get(ip);
  return !f || f.until < Date.now() || f.n < 5;
}
export function recordLogin(ip, ok) {
  if (ok) { fails.delete(ip); return; }
  const f = fails.get(ip) || { n: 0, until: 0 };
  f.n += 1; f.until = Date.now() + 60_000;
  fails.set(ip, f);
}
