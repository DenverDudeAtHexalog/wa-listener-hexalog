// HTTP routes for everything that changes something on WhatsApp. All need the ADMIN_API_KEY (header only).
import express from 'express';
import { config } from './config.js';
import { requireAdmin } from './auth.js';
import * as A from './actions.js';

export const router = express.Router();

const handle = (fn) => async (req, res) => {
  try {
    res.json({ ok: true, ...(await fn(req)) });
  } catch (e) {
    const err = A.waError(e);
    res.status(err.status).json({ ok: false, error: err.message, ...err.extra });
  }
};

// Routes that carry files need a bigger body limit than the rest of the API; they are parsed here, after auth.
const bigJson = express.json({ limit: `${Math.ceil(config.maxMediaMb * 1.4) + 1}mb` });
export const BIG_BODY_ROUTE = /^\/api\/(send\/media|groups\/[^/]+\/picture|profile\/picture)\/?$/;

const post = (path, fn, ...mw) => router.post(path, requireAdmin, ...mw, handle(fn));
const put = (path, fn, ...mw) => router.put(path, requireAdmin, ...mw, handle(fn));
const get = (path, fn) => router.get(path, requireAdmin, handle(fn));
const del = (path, fn) => router.delete(path, requireAdmin, handle(fn));

// ---- sending messages
post('/send/text', (req) => A.sendText(req.body || {}));
post('/send/media', (req) => A.sendMedia(req.body || {}), bigJson);
post('/send/location', (req) => A.sendLocation(req.body || {}));
post('/send/contact', (req) => A.sendContacts(req.body || {}));
post('/send/poll', (req) => A.sendPoll(req.body || {}));

// ---- acting on an existing message (by its uid)
post('/messages/:uid/react', (req) => A.react(Number(req.params.uid), req.body?.emoji));
post('/messages/:uid/edit', (req) => A.editMessage(Number(req.params.uid), req.body?.text));
post('/messages/:uid/delete', (req) => A.deleteMessage(Number(req.params.uid)));
post('/messages/:uid/read', (req) => A.markRead(Number(req.params.uid)));
post('/presence', (req) => A.setPresence(req.body || {}));
post('/lookup', (req) => A.lookupNumbers(req.body?.numbers));

// ---- groups
post('/groups', (req) => A.createGroup(req.body || {}));
post('/groups/join', (req) => A.joinGroup(req.body?.invite));
post('/groups/:jid/participants', (req) => A.updateParticipants(req.params.jid, req.body || {}));
put('/groups/:jid/subject', (req) => A.setSubject(req.params.jid, req.body?.subject));
put('/groups/:jid/description', (req) => A.setDescription(req.params.jid, req.body?.description));
put('/groups/:jid/settings', (req) => A.setGroupSettings(req.params.jid, req.body || {}));
put('/groups/:jid/picture', (req) => A.setGroupPicture(req.params.jid, req.body?.data_base64), bigJson);
del('/groups/:jid/picture', (req) => A.removeGroupPicture(req.params.jid));
get('/groups/:jid/invite', (req) => A.getInvite(req.params.jid));
post('/groups/:jid/invite/revoke', (req) => A.revokeInvite(req.params.jid));
post('/groups/:jid/leave', (req) => A.leaveGroup(req.params.jid));
post('/groups/:jid/refresh', (req) => A.refreshGroup(req.params.jid));
get('/groups/:jid/join-requests', (req) => A.joinRequests(req.params.jid));
post('/groups/:jid/join-requests', (req) => A.decideJoinRequests(req.params.jid, req.body || {}));

// ---- the linked number's own profile
put('/profile/name', (req) => A.setProfileName(req.body?.name));
put('/profile/status', (req) => A.setProfileStatus(req.body?.status));
put('/profile/picture', (req) => A.setProfilePicture(req.body?.data_base64), bigJson);
del('/profile/picture', () => A.removeProfilePicture());

// ---- audit log of everything done through this API
get('/actions', (req) => A.recentActions(parseInt(req.query.limit, 10) || 100));
