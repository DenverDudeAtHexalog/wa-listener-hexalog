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

export function makeCookie() {
  const exp = String(Date.now() + TTL_MS);
  return `${COOKIE}=${exp}.${hmac(exp)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${TTL_MS / 1000}`;
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

export function hasPortalSession(req) {
  const c = readCookie(req);
  if (!c) return false;
  const [exp, sig] = c.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEq(sig, hmac(exp));
}

export function hasApiKey(req) {
  const h = req.headers['x-api-key'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.query.api_key;
  return !!h && safeEq(h, config.apiKey);
}

export const requirePortal = (req, res, next) =>
  hasPortalSession(req) ? next() : res.status(401).json({ error: 'login required' });

export const requireApi = (req, res, next) =>
  hasApiKey(req) || hasPortalSession(req) ? next() : res.status(401).json({ error: 'invalid or missing API key' });

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
