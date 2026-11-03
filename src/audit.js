import { q } from './db.js';

/** Audit log of everything done through the write API (optionally for one number). */
export async function recentActions(limit = 100, numberId = null) {
  const { rows } = await q(
    `SELECT id, number_id, ts, kind, action, target, summary, ok, error FROM actions_log
      WHERE ($2::int IS NULL OR number_id = $2) ORDER BY id DESC LIMIT $1`,
    [Math.min(500, Math.max(1, limit)), numberId]);
  return { actions: rows };
}
