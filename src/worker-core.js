// The code that runs inside one worker process. A worker owns exactly one WhatsApp number (config.numberId):
// its Baileys connection, message ingestion into Postgres, and its paced write queue + quotas.
// It talks to the API process over Node's IPC channel (see manager.js for the other side).
import { config } from './config.js';
import { bus } from './bus.js';
import { session } from './session.js';
import * as A from './actions.js';
import { fetchMedia } from './ingest.js';
import { HttpError } from './errors.js';

// Only these action functions can be invoked remotely.
export const RPC_ALLOWED = new Set([
  'sendText', 'sendMedia', 'sendLocation', 'sendContacts', 'sendPoll', 'react', 'editMessage', 'deleteMessage', 'markRead',
  'setPresence', 'lookupNumbers', 'createGroup', 'updateParticipants', 'setSubject', 'setDescription', 'setGroupSettings',
  'setGroupPicture', 'removeGroupPicture', 'getInvite', 'revokeInvite', 'joinGroup', 'leaveGroup', 'refreshGroup',
  'joinRequests', 'decideJoinRequests', 'setProfileName', 'setProfileStatus', 'setProfilePicture', 'removeProfilePicture',
]);

const FORWARDED_EVENTS = ['message.created', 'message.updated', 'message.deleted', 'reaction', 'group.updated'];

/** Work out what to run for one request message. Shared by the forked worker and by inline mode. */
export async function execute(m, extra = {}) {
  if (extra[m.t]) return extra[m.t](m); // tests plug a fake WhatsApp in here
  switch (m.t) {
    case 'start': return session.start({ phone: m.phone });
    case 'stop': await session.stop(); return session.status();
    case 'logout': await session.logout(); return session.status();
    case 'status': return session.status();
    case 'rpc': {
      if (!RPC_ALLOWED.has(m.fn)) throw new HttpError(400, 'unknown action ' + m.fn);
      return A[m.fn](...(m.args || []));
    }
    case 'media': {
      if (!session.sock || session.state !== 'open') throw new HttpError(503, 'WhatsApp is not connected right now; try again in a moment');
      return fetchMedia(session.sock, m.row);
    }
    default:
      throw new HttpError(400, 'unknown request ' + m.t);
  }
}

export function runWorker({ extra = {} } = {}) {
  const send = (msg) => { try { process.send?.(msg); } catch { /* parent gone */ } };

  bus.on('session.state', (status) => send({ t: 'state', status }));
  for (const ev of FORWARDED_EVENTS) bus.on(ev, (data) => send({ t: 'event', ev, data }));

  process.on('message', async (m) => {
    if (!m || !m.rid) return;
    try {
      const result = await execute(m, extra);
      send({ t: 'reply', rid: m.rid, ok: true, result });
    } catch (e) {
      const err = e instanceof HttpError ? e : A.waError(e);
      send({ t: 'reply', rid: m.rid, ok: false, error: { status: err.status || 500, message: err.message, extra: err.extra || {} } });
    }
  });

  process.on('disconnect', () => process.exit(0)); // the API process is gone
  process.on('unhandledRejection', (e) => console.error(`[worker ${config.numberId}] unhandled`, e?.message || e));
  process.on('uncaughtException', (e) => { console.error(`[worker ${config.numberId}] fatal`, e); process.exit(1); });
  send({ t: 'ready' });
}
