// A worker process with a fake WhatsApp socket, for tests. Same code path as production (worker-core.js);
// only the connection to WhatsApp is replaced.
import { config } from '../src/config.js';
import { bus } from '../src/bus.js';
import { session } from '../src/session.js';
import { ingestMessage, upsertGroup } from '../src/ingest.js';
import { runWorker } from '../src/worker-core.js';

const id = config.numberId;
const calls = [];
let n = 0;
const rec = (name, impl) => async (...args) => { calls.push([name, ...args]); return impl ? impl(...args) : undefined; };
const sock = {
  user: { id: `91900000000${id}:1@s.whatsapp.net` },
  onWhatsApp: rec('onWhatsApp', (...phones) => phones.map((p) => ({ jid: p + '@s.whatsapp.net', exists: true }))),
  sendMessage: rec('sendMessage', (jid, content) => ({
    key: { remoteJid: jid, id: `OUT${id}-${++n}`, fromMe: true, participant: jid.endsWith('@g.us') ? `91900000000${id}@s.whatsapp.net` : undefined },
    messageTimestamp: Math.floor(Date.now() / 1000), message: content.text ? { conversation: content.text } : { conversation: '[' + Object.keys(content)[0] + ']' },
  })),
  groupCreate: rec('groupCreate', (subject, jids) => ({ id: `1203630000000000${id}0@g.us`, subject, participants: jids.map((j) => ({ id: j })) })),
  groupUpdateSubject: rec('groupUpdateSubject'),
  groupParticipantsUpdate: rec('groupParticipantsUpdate', (jid, jids, action) => jids.map((j) => ({ jid: j, status: '200' }))),
  groupMetadata: rec('groupMetadata', (jid) => ({ id: jid, subject: 'Acme CX', participants: [] })),
};

runWorker({
  extra: {
    start: async () => { session.sock = sock; session.state = 'open'; session.me = { jid: sock.user.id, name: null }; bus.emit('session.state', session.status()); return session.status(); },
    stop: async () => { session.sock = null; session.state = 'idle'; bus.emit('session.state', session.status()); return session.status(); },
    ingest: async (m) => { await ingestMessage(sock, m.msg, { fromHistory: !!m.fromHistory }); return { ok: true }; },
    group: async (m) => { await upsertGroup(m.meta); return { ok: true }; },
    calls: async () => calls,
    die: async () => { process.exit(9); },
  },
});
