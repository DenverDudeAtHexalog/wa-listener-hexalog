import fs from 'node:fs/promises';
import path from 'node:path';
import pino from 'pino';
import QRCode from 'qrcode';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from 'baileys';
import { config, authDirFor } from './config.js';
import { q } from './db.js';
import { bus } from './bus.js';
import { ingestMessage, upsertGroup } from './ingest.js';

const logger = pino({ level: config.logLevel });
const AUTH_DIR = authDirFor(config.numberId);

/**
 * One WhatsApp number (this process serves the number in config.numberId). States:
 *  idle -> connecting -> qr | pairing -> open ; open -> reconnecting -> open ; logged_out ; replaced
 * It only sends when the API asks it to (see actions.js); it never sends read receipts by itself.
 */
class WhatsAppSession {
  constructor() {
    this.sock = null;
    this.state = 'idle';
    this.qr = null; // data URL
    this.pairingCode = null;
    this.pendingPhone = null;
    this.me = null;
    this.lastError = null;
    this.retries = 0;
    this.stopping = false;
    this.generation = 0; // ignore events from stale sockets
    this.chain = Promise.resolve(); // keeps message ingestion ordered
    this.reconnectTimer = null;
  }

  status() {
    return {
      number_id: config.numberId,
      state: this.state,
      qr: this.qr,
      pairing_code: this.pairingCode,
      me: this.me,
      last_error: this.lastError,
      linked: this.state === 'open',
      writes_enabled: !!config.adminApiKey,
    };
  }

  setState(state, detail) {
    this.state = state;
    if (state !== 'qr') this.qr = null;
    if (state !== 'pairing') this.pairingCode = null;
    q('INSERT INTO connection_log (number_id, state, detail) VALUES ($1,$2,$3)', [config.numberId, state, detail || null]).catch(() => {});
    bus.emit('session.state', this.status()); // the manager turns this into the public 'connection' event
  }

  async hasSavedLogin() {
    try {
      await fs.access(path.join(AUTH_DIR, 'creds.json'));
      return true;
    } catch {
      return false;
    }
  }

  /** Start (or restart) the connection. If `phone` is given and no login exists, use a pairing code instead of QR. */
  async start({ phone } = {}) {
    if (this.state === 'open') return this.status();
    clearTimeout(this.reconnectTimer);
    this.stopping = false;
    this.pendingPhone = phone ? String(phone).replace(/\D/g, '') : null;
    await this.#connect();
    return this.status();
  }

  async #connect() {
    const gen = ++this.generation;
    if (this.sock) {
      try { this.sock.end(undefined); } catch { /* ignore */ }
      this.sock = null;
    }
    this.setState('connecting');
    await fs.mkdir(AUTH_DIR, { recursive: true });
    const { state: auth, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

    const sock = makeWASocket({
      version,
      auth,
      logger,
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false, // stay invisible
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
    });
    this.sock = sock;
    let pairingRequested = false;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (u) => {
      if (gen !== this.generation) return;
      const { connection, lastDisconnect, qr } = u;

      if (qr) {
        if (this.pendingPhone && !pairingRequested && !sock.authState.creds.registered) {
          pairingRequested = true;
          try {
            const code = await sock.requestPairingCode(this.pendingPhone);
            this.pairingCode = code?.match(/.{1,4}/g)?.join('-') || code;
            this.setState('pairing');
          } catch (e) {
            this.lastError = 'pairing code failed: ' + e.message;
            this.setState('connecting', this.lastError);
          }
          return;
        }
        if (!this.pendingPhone) {
          this.qr = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
          this.setState('qr');
        }
      }

      if (connection === 'open') {
        this.retries = 0;
        this.lastError = null;
        this.pendingPhone = null;
        this.me = sock.user ? { jid: sock.user.id, name: sock.user.name || null } : null;
        this.setState('open');
        if (this.me?.jid) {
          const phone = this.me.jid.split(':')[0].split('@')[0];
          q('UPDATE numbers SET phone = $2 WHERE id = $1', [config.numberId, phone]).catch(() => {}); // unique: ignore if another row has it
        }
        this.#syncGroups(sock).catch((e) => logger.warn({ e: e.message }, 'group sync failed'));
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        this.lastError = lastDisconnect?.error?.message || null;
        this.sock = null;
        if (this.stopping) return;

        if (code === DisconnectReason.loggedOut) {
          await this.#wipeAuth();
          this.me = null;
          this.setState('logged_out', 'logged out from the phone');
        } else if (code === DisconnectReason.connectionReplaced) {
          this.setState('replaced', 'this number is connected somewhere else');
        } else if (code === DisconnectReason.restartRequired) {
          await this.#connect(); // normal right after scanning the QR
        } else {
          this.#scheduleReconnect();
        }
      }
    });

    // --- Message listening -------------------------------------------------------------
    sock.ev.on('messages.upsert', ({ messages }) => {
      if (gen !== this.generation) return;
      for (const m of messages) this.#queue(() => ingestMessage(sock, m));
    });

    sock.ev.on('messaging-history.set', ({ messages }) => {
      if (gen !== this.generation || !config.ingestHistory) return;
      for (const m of messages || []) this.#queue(() => ingestMessage(sock, m, { fromHistory: true }));
    });

    // --- Group metadata ----------------------------------------------------------------
    const refreshGroup = async (jid) => {
      try { await upsertGroup(await sock.groupMetadata(jid)); bus.emit('group.updated', { number_id: config.numberId, jid }); }
      catch (e) { logger.warn({ jid, e: e.message }, 'groupMetadata failed'); }
    };
    sock.ev.on('groups.upsert', (gs) => gs.forEach((g) => upsertGroup(g).then(() => bus.emit('group.updated', { number_id: config.numberId, jid: g.id })).catch(() => {})));
    sock.ev.on('groups.update', (us) => us.forEach((u) => u.id && refreshGroup(u.id)));
    sock.ev.on('group-participants.update', (u) => u.id && refreshGroup(u.id));
  }

  #queue(fn) {
    this.chain = this.chain.then(fn).catch((e) => logger.error({ e: e.message }, 'ingest failed'));
  }

  async #syncGroups(sock) {
    const all = await sock.groupFetchAllParticipating();
    for (const g of Object.values(all)) await upsertGroup(g);
    bus.emit('group.updated', { number_id: config.numberId, count: Object.keys(all).length });
  }

  #scheduleReconnect() {
    this.retries += 1;
    const delay = Math.min(30_000, 2 ** this.retries * 1000);
    this.setState('reconnecting', `retry in ${delay / 1000}s (${this.lastError || 'connection closed'})`);
    this.reconnectTimer = setTimeout(() => this.#connect().catch((e) => {
      this.lastError = e.message;
      this.#scheduleReconnect();
    }), delay);
  }

  async #wipeAuth() {
    await fs.rm(AUTH_DIR, { recursive: true, force: true });
  }

  /** Disconnect and keep the saved login (service stays linked on next start). */
  async stop() {
    this.stopping = true;
    clearTimeout(this.reconnectTimer);
    this.generation++;
    try { this.sock?.end(undefined); } catch { /* ignore */ }
    this.sock = null;
    this.setState('idle', 'stopped');
  }

  /** Log the number out of WhatsApp (removes the linked device) and delete the saved keys. */
  async logout() {
    this.stopping = true;
    clearTimeout(this.reconnectTimer);
    this.generation++;
    try { await this.sock?.logout(); } catch { /* already gone */ }
    this.sock = null;
    await this.#wipeAuth();
    this.me = null;
    this.setState('logged_out', 'unlinked from portal');
  }
}

export const session = new WhatsAppSession();
