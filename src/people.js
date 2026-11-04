// The people who use the portal: the owner (portal password) and team members with their own login.
import express from 'express';
import { q } from './db.js';
import { HttpError } from './errors.js';
import { hashPassword, verifyPassword, setPeople, requirePortal, requirePortalAdmin } from './auth.js';

export async function loadPeople() {
  const { rows } = await q('SELECT id, name, role, active FROM users');
  setPeople(rows);
}

const clean = (s, max = 60) => String(s ?? '').trim().slice(0, max);
const USERNAME = /^[a-z0-9._-]{3,30}$/;
const ROLES = ['agent', 'admin'];

function checkPassword(p) {
  if (typeof p !== 'string' || p.length < 8) throw new HttpError(400, 'password must be at least 8 characters');
  if (p.length > 200) throw new HttpError(400, 'password is too long');
}

/** Look a person up by username and password. Returns the row or null. */
export async function loginUser(username, password) {
  const { rows } = await q('SELECT * FROM users WHERE username = $1 AND active', [clean(username, 30).toLowerCase()]);
  const u = rows[0];
  // verify against a dummy hash when the user does not exist, so timing does not reveal which usernames exist
  const ok = verifyPassword(password, u ? u.password_hash : 'scrypt$00$00');
  return u && ok ? u : null;
}

export const router = express.Router();
const wrap = (fn) => async (req, res) => {
  try { res.json(await fn(req)); }
  catch (e) {
    if (Number.isInteger(e.status)) return res.status(e.status).json({ error: e.message });
    console.error('[people]', e); res.status(500).json({ error: 'internal error' });
  }
};
const shape = (r) => ({ id: r.id, username: r.username, name: r.name, role: r.role, active: r.active, created_at: r.created_at });

router.get('/users', requirePortalAdmin, wrap(async () => ({
  users: (await q('SELECT id, username, name, role, active, created_at FROM users ORDER BY active DESC, name')).rows.map(shape),
})));

router.post('/users', requirePortalAdmin, wrap(async (req) => {
  const username = clean(req.body?.username, 30).toLowerCase(), name = clean(req.body?.name), role = req.body?.role || 'agent';
  if (!USERNAME.test(username)) throw new HttpError(400, 'username: 3 to 30 letters, numbers, dot, dash or underscore');
  if (username === 'owner') throw new HttpError(400, '"owner" is reserved');
  if (!name) throw new HttpError(400, 'name is required');
  if (!ROLES.includes(role)) throw new HttpError(400, 'role must be agent or admin');
  checkPassword(req.body?.password);
  try {
    const { rows } = await q('INSERT INTO users (username, name, role, password_hash) VALUES ($1,$2,$3,$4) RETURNING *', [username, name, role, hashPassword(req.body.password)]);
    await loadPeople();
    return { user: shape(rows[0]) };
  } catch (e) {
    if (e.code === '23505') throw new HttpError(409, 'that username is taken');
    throw e;
  }
}));

router.put('/users/:id', requirePortalAdmin, wrap(async (req) => {
  const id = Number(req.params.id), b = req.body || {}, sets = [], p = [id];
  const set = (col, v) => { p.push(v); sets.push(`${col} = $${p.length}`); };
  if (b.name !== undefined) { const n = clean(b.name); if (!n) throw new HttpError(400, 'name cannot be empty'); set('name', n); }
  if (b.role !== undefined) { if (!ROLES.includes(b.role)) throw new HttpError(400, 'role must be agent or admin'); set('role', b.role); }
  if (b.active !== undefined) set('active', !!b.active);
  if (b.password !== undefined) { checkPassword(b.password); set('password_hash', hashPassword(b.password)); }
  if (!sets.length) throw new HttpError(400, 'nothing to change');
  const { rows } = await q(`UPDATE users SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, p);
  if (!rows[0]) throw new HttpError(404, 'no such user');
  await loadPeople();
  return { user: shape(rows[0]) };
}));

// People change their own password.
router.post('/password', requirePortal, wrap(async (req) => {
  if (!req.me.id) throw new HttpError(400, 'the owner password is set in the server settings (PORTAL_PASSWORD)');
  const { rows } = await q('SELECT password_hash FROM users WHERE id = $1', [req.me.id]);
  if (!rows[0] || !verifyPassword(req.body?.old, rows[0].password_hash)) throw new HttpError(403, 'current password is wrong');
  checkPassword(req.body?.new);
  await q('UPDATE users SET password_hash = $2 WHERE id = $1', [req.me.id, hashPassword(req.body.new)]);
  return { ok: true };
}));
