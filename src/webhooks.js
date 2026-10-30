import crypto from 'node:crypto';
import { q } from './db.js';
import { config } from './config.js';
import { bus } from './bus.js';

const EVENTS = ['message.created', 'message.updated', 'message.deleted', 'reaction', 'group.updated', 'connection'];
export const WEBHOOK_EVENTS = EVENTS;

export function sign(secret, body) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

export async function ensureDefaultWebhook() {
  if (!config.defaultWebhookUrl) return;
  const { rows } = await q('SELECT id FROM webhooks WHERE url = $1', [config.defaultWebhookUrl]);
  if (rows.length) return;
  await q('INSERT INTO webhooks (url, secret, events) VALUES ($1,$2,$3)', [
    config.defaultWebhookUrl,
    config.defaultWebhookSecret || crypto.randomBytes(16).toString('hex'),
    [],
  ]);
}

async function enqueue(event, data) {
  const { rows } = await q(
    `SELECT id FROM webhooks WHERE active AND (cardinality(events) = 0 OR $1 = ANY(events))`,
    [event]
  );
  if (!rows.length) return;
  const payload = { event, ts: new Date().toISOString(), data };
  for (const w of rows) {
    await q('INSERT INTO webhook_deliveries (webhook_id, event, payload) VALUES ($1,$2,$3)', [w.id, event, payload]);
  }
}

export function startWebhookDispatcher() {
  for (const ev of EVENTS) {
    bus.on(ev, (data) => enqueue(ev, data).catch((e) => console.error('[webhook] enqueue failed', e.message)));
  }

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const { rows } = await q(
        `SELECT d.*, w.url, w.secret FROM webhook_deliveries d
         JOIN webhooks w ON w.id = d.webhook_id
         WHERE d.status = 'pending' AND d.next_attempt <= now()
         ORDER BY d.id LIMIT 20`
      );
      await Promise.all(rows.map(deliver));
    } catch (e) {
      console.error('[webhook] dispatcher error', e.message);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, 2000);
  timer.unref?.();
  return () => clearInterval(timer);
}

async function deliver(d) {
  const body = JSON.stringify({ ...d.payload, delivery_id: Number(d.id) });
  const attempts = d.attempts + 1;
  try {
    const res = await fetch(d.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-walistener-event': d.event,
        'x-walistener-delivery': String(d.id),
        'x-walistener-signature': sign(d.secret, body),
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    await q(`UPDATE webhook_deliveries SET status='delivered', attempts=$2, delivered_at=now(), last_error=NULL WHERE id=$1`, [d.id, attempts]);
  } catch (e) {
    if (attempts >= config.webhookMaxAttempts) {
      await q(`UPDATE webhook_deliveries SET status='failed', attempts=$2, last_error=$3 WHERE id=$1`, [d.id, attempts, e.message]);
    } else {
      const delaySec = Math.min(3600, 2 ** attempts * 5); // 10s, 20s, 40s ... 1h
      await q(
        `UPDATE webhook_deliveries SET attempts=$2, last_error=$3, next_attempt = now() + ($4 || ' seconds')::interval WHERE id=$1`,
        [d.id, attempts, e.message, String(delaySec)]
      );
    }
  }
}
