# wa-listener: Technical Architecture & Behaviour Report

**Scope:** read-only code inspection of the local working copy (`wa-listener`, the clone of `wa-listener-hexalog`). Nothing was modified, run or installed. No secrets, phone numbers or message contents appear below; placeholders are redacted.

**Files read in full:** `package.json`, `.env.example`, `.gitignore`, `.dockerignore`, `Dockerfile`, `docker-compose.yml`, `docker-compose.caddy.yml`, `render.yaml`, `README.md`, `deploy/{setup,backup,update}.sh`, `public/index.html`, and every file in `src/`: `server.js`, `manager.js`, `session.js`, `worker.js`, `worker-core.js`, `ingest.js`, `actions.js`, `writes.js`, `auth.js`, `config.js`, `db.js`, `webhooks.js`, `audit.js`, `bus.js`, `errors.js`.

**Not read, so not verified:** `public/docs.html`, `public/hexalog.css`, `test/*.js` (listed only), `scripts/api_tester/*` (Python helper, listed only), `package-lock.json`, `node_modules` (not present, so the installed Baileys version and its internals are unverified), `.git` history, any real `.env`, and any runtime behaviour. Nothing was executed.

---

## 1. Project Architecture

### 1.1 Technologies and libraries

| Layer | What is used | Source |
|---|---|---|
| Runtime | Node.js ≥ 20 (`engines`); Docker image `node:22-alpine`; ES modules (`"type": "module"`) | `package.json`, `Dockerfile` |
| WhatsApp | `baileys` `^7.0.0-rc14` | `package.json` |
| HTTP | `express` `^4.22.3` (no CORS, helmet or rate-limit middleware) | `package.json`, `server.js` |
| Database | `pg` `^8.23.1` against PostgreSQL (`postgres:16-alpine` in compose) | `db.js`, `docker-compose.yml` |
| Logging | `pino` `^10.4.0` (default level `warn`) | `session.js`, `config.js` |
| QR | `qrcode` `^1.5.4` | `session.js` |
| Frontend | Static HTML/CSS/JS, no build step (`public/index.html`, `docs.html`, `hexalog.css`) | `public/` |
| Deployment | Dockerfile, compose, optional Caddy overlay, `render.yaml`, AWS EC2 scripts in `deploy/` | repo root |
| Side tooling | Python API tester `scripts/api_tester/` (not inspected); `.venv` and `.idea` exist locally and are git-ignored | `.gitignore` |

### 1.2 How Baileys is integrated

- Baileys is imported in two places only, and both run inside a **worker process**:
  - `src/session.js` imports `makeWASocket` (default export), `Browsers`, `DisconnectReason`, `fetchLatestBaileysVersion` and `useMultiFileAuthState`. The class `WhatsAppSession` creates the socket in `#connect()`.
  - `src/ingest.js` imports `downloadMediaMessage`, `extractMessageContent`, `getContentType` and `isJidGroup`.
- Socket options (`session.js` lines 91-99): `browser: Browsers.ubuntu('Chrome')`, `markOnlineOnConnect: false`, `syncFullHistory: false`, `generateHighQualityLinkPreview: false`, and a pino logger.
- `manager.js` deliberately does **not** import Baileys. In the default `fork` mode the API process never loads it. In `inline` mode (tests) it lazy-imports `worker-core.js` and `session.js`.

### 1.3 Entry points

| Entry | Purpose |
|---|---|
| `src/server.js` | Main entry (`package.json` `main` and `npm start`; Dockerfile `CMD ["node","src/server.js"]`). `main()` runs only when the file is executed directly (`process.argv[1]` check). |
| `src/worker.js` | Entry of each per-number child process. It calls `runWorker()` from `worker-core.js`. It is started only by `manager.js` via `child_process.fork`. |

Startup order in `server.js` `main()`:

1. `assertConfig()` requires `API_KEY` and `PORTAL_PASSWORD`, and a session secret (`SESSION_SECRET`, falling back to `API_KEY`). It rejects `ADMIN_API_KEY` equal to `API_KEY`.
2. `fs.mkdirSync(DATA_DIR)`.
3. `migrate()`.
4. `ensureDefaultWebhook()`.
5. `startWebhookDispatcher()`.
6. `buildApp().listen(PORT, HOST)`.
7. `manager.init()`.

### 1.4 How the modules connect

```
                         API PROCESS  (node src/server.js)
 Browser (portal) ──cookie──► server.js ── auth.js (key / cookie / login limiter)
 API clients ──x-api-key──►     │   │
                                │   ├── writes.js ──► manager.call()  ─┐  (admin key; 'rpc')
                                │   └── read routes ─► db.js (Postgres) │
                                ▼                                       │
                           manager.js  (supervises workers, holds       │
                           number rows + last status in memory)         │
                                │  IPC (child_process.fork, 'advanced') │
 webhooks.js ◄── bus.js ◄───────┤  {t:'state'|'event'|'reply'|'ready'}  │
 (HMAC POST,    EventEmitter    │                                       │
  retry queue)  + SSE streams   ▼                                       ▼
              ┌──────────────── WORKER PROCESS (one per number, worker.js) ───────────┐
              │ worker-core.js ─ session.js (Baileys socket, QR/pairing, reconnect)   │
              │                  ├─ ingest.js  (parse → Postgres, emit events)        │
              │                  └─ actions.js (paced send/group/profile writes)      │
              └───────────────────────────────────────────────────────────────────────┘
                              │                           │
                    data/auth/<numberId>/          PostgreSQL (each worker has its own pool of 3)
```

- **Process model.** One API process plus one forked worker per WhatsApp number (`manager.js` `spawn()`). Each worker runs with `NUMBER_ID`, `DB_POOL_MAX=3` and `--max-old-space-size=WORKER_MAX_MB` (default 256).
- **IPC protocol** (`manager.js` ↔ `worker-core.js`):
  - Manager to worker requests: `start`, `stop`, `logout`, `status`, `rpc` (an action name from the `RPC_ALLOWED` whitelist) and `media`.
  - Worker to manager messages: `ready`, `state`, `event`, `reply`.
  - The manager never sends `status`, although `worker-core.js` handles it.
- **Event bus.** `bus.js` is a plain `EventEmitter`.
  - Workers forward `message.created`, `message.updated`, `message.deleted`, `reaction` and `group.updated` to the manager, which re-emits them locally.
  - The manager itself emits `connection` and `numbers.changed`.
  - `webhooks.js` and the `/api/stream` and `/portal/events` SSE endpoints subscribe to the bus.
- **Persistence.** Workers write messages directly to Postgres (`ingest.js`). The API process reads from the same database.
- **Multi-number.** `manager.js` keeps in-memory maps (`rows`, `statuses`, `workers`, `desired`, `restarts`). The `numbers` table is the registry.

---

## 2. WhatsApp Connection

### 2.1 How it connects

1. `manager.init()` runs `migrateLegacyAuth()`. This moves an old `data/auth/creds.json` into `data/auth/1/`. It then calls `loadNumbers()` from the `numbers` table.
2. Unless `AUTO_CONNECT=false`, it starts every number with `auto_connect = true` **and** an existing `creds.json`. Starts are staggered 1.5 s apart.
3. `manager.start(id)` forks `worker.js`. The worker's `session.start()` calls `#connect()`:
   - It creates the auth dir.
   - It calls `useMultiFileAuthState(AUTH_DIR)`.
   - It calls `fetchLatestBaileysVersion()`. On failure it continues with `version: undefined`.
   - It calls `makeWASocket(...)`.
4. A per-session `generation` counter makes handlers ignore events from stale sockets.
5. Session states: `idle → connecting → qr | pairing → open ↔ reconnecting`, plus `logged_out` and `replaced`. Every state change is written to `connection_log` and pushed to the manager over IPC.

**Disconnect handling** (`session.js` `connection.update`, `close` branch):

| Condition | Behaviour |
|---|---|
| `DisconnectReason.loggedOut` | Deletes the auth dir (`#wipeAuth`), clears `me`, state `logged_out` |
| `connectionReplaced` | State `replaced`; no retry |
| `restartRequired` | Immediate reconnect (normal right after a QR scan) |
| Anything else | Exponential backoff: `min(30 s, 2^retries s)` |
| Worker process dies | Manager restarts it after `min(30 s, 1 s × 2^n)` if the number is in `desired` |

### 2.2 QR authentication

- When Baileys emits `qr` and no phone was supplied, `session.js` converts it with `QRCode.toDataURL(qr, {margin:1, width:320})`. The result is a base64 PNG data URL kept in `this.qr` (memory only) with state `qr`.
- The worker sends that status to the manager over IPC. The manager stores it in `statuses` and emits `numbers.changed`. `GET /portal/events` (SSE, cookie-protected) pushes it to the browser, and `public/index.html` renders it as an `<img>`.
- The QR is **never written to disk** or the database. It is **not** in the public API: `manager.list()` omits `qr` and `pairing_code` unless `{secrets:true}`, which only `/portal/*` routes use. The public `connection` event is built without the QR.
- **Pairing-code alternative:** `POST /portal/numbers/:id/connect {phone}` (8-15 digits). When a QR event arrives and the number is not yet registered, the worker calls `sock.requestPairingCode(phone)`. The code is formatted `XXXX-XXXX` and state becomes `pairing`.
- The UI text says the QR "refreshes every ~20 seconds". That is Baileys' behaviour; the repo does not control it.

### 2.3 Where credentials are stored

- **Path:** `<DATA_DIR>/auth/<numberId>/` (`config.js` `authDirFor`).
  - `DATA_DIR` is `path.resolve(env.DATA_DIR || './data')`. The default is **relative to the process working directory**.
  - Docker: `DATA_DIR=/data` on named volume `appdata`.
  - Render: persistent disk mounted at `/data`.
- **Written by:** Baileys `useMultiFileAuthState` (via `creds.update` → `saveCreds`).
- The repo explicitly relies on `creds.json` in that directory (`hasSavedLogin`). The other key files Baileys writes there are Baileys' behaviour and were not inspected here.
- **Not encrypted by this code.** `.gitignore` excludes `data` and `.env`; `.dockerignore` excludes `data`, `.env` and `test`.
- **Deleted** on `loggedOut` (phone unlinked the device) and on portal "Unlink" (`logout()` calls `sock.logout()` then wipes).
- Pausing ("Pause listening", `stop()`) keeps the login.

### 2.4 Separate sessions or isolated environments

- **Per number:** a separate OS process (`child_process.fork`) with a heap cap, a separate auth directory, its own DB pool (3 connections) and its own paced write queue and quota counters (`actions.js` is per-process). A crash in one worker does not stop the others.
- Up to `MAX_NUMBERS` (default 30). README estimates about 100 MB RAM per connected number.
- This is **process isolation only**. There is no chroot, container-per-number, VM or filesystem sandbox. All workers share the same user, filesystem and database.
- **Same number on two hosts:** if a number is already linked elsewhere (for example a QA copy and a production copy sharing one login), WhatsApp returns "connection replaced". The code stops retrying and shows `replaced`.

---

## 3. Sandbox and Local Storage

### 3.1 Sandbox / temp / local environment

- **No sandbox or temp directory is created by this code.** None of the files read uses `os.tmpdir()`, `mkdtemp` or similar.
- **Unverified:** Baileys internals (not inspected, `node_modules` absent) may use the OS temp directory when processing media.
- Directories the code creates:

| Path | Created by | When |
|---|---|---|
| `<DATA_DIR>` | `server.js` `mkdirSync` | Every start |
| `<DATA_DIR>/auth/<id>/` | `session.js` `#connect` | When a number is started |
| `<DATA_DIR>/media/<YYYY-MM-DD>/` | `ingest.js` `saveMedia` | **Only** when `MEDIA_MODE=store` |

- Docker/Render are the deployment containers, not application-level sandboxes.

### 3.2 Are WhatsApp messages stored locally?

**Yes, permanently, in PostgreSQL (not in local files).** There is no retention, TTL or purge job in the code. Message rows are inserted by `ingestMessage` in `ingest.js` and remain until someone deletes them in SQL.

### 3.3 Where everything lives

| Data | Location | Notes |
|---|---|---|
| WhatsApp login keys | `<DATA_DIR>/auth/<id>/` | Filesystem; volume `appdata` in Docker |
| Messages, groups, reactions, numbers | PostgreSQL | Docker volume `pgdata`, or Render managed DB |
| Media files | `<DATA_DIR>/media/<date>/<random>.<ext>` | Only with `MEDIA_MODE=store`; default `ondemand` saves no files |
| Media re-download info | `messages.media_ref` (jsonb) | Includes the media decryption key, direct path and hashes |
| Webhook definitions and secrets | `webhooks` table | Secrets stored in plain text |
| Webhook delivery queue | `webhook_deliveries.payload` (jsonb) | Full copy of each event payload |
| Audit log of API writes | `actions_log` | Includes short summaries (for example the first 80 characters of sent text) |
| Connection history | `connection_log` | State and detail strings |
| Application logs | stdout / stderr only | pino (`LOG_LEVEL`, default `warn`) plus `console.log/error`. **No log files are written by the app.** Container log handling is not configured in the repo. |
| Backups (only if `deploy/backup.sh` is scheduled) | `${BACKUP_DIR:-/var/backups/wa-listener}` | `pg_dump` gz **and** a tar of `/data` (includes auth keys); files older than 14 days are deleted; not encrypted by the script |

### 3.4 Database

PostgreSQL (`pg` Pool in `db.js`).

- `DATABASE_URL` falls back to `postgres://<default-superuser>:<default-password>@localhost:5432/walistener` when unset (`config.js` line 16).
- Schema is created and migrated at startup (`migrate()`), guarded by advisory lock `727001`.
- Tables:

| Table | Purpose |
|---|---|
| `messages` | One row per message copy (`uid` bigserial; unique `(number_id, chat_jid, id)`) |
| `wa_groups` | Group metadata per number; PK `(number_id, jid)`; `participants` jsonb |
| `reactions` | Per reactor, per message |
| `numbers` | Registry of linked numbers (`label`, `phone`, `auto_connect`) |
| `webhooks`, `webhook_deliveries` | Webhook config and delivery queue |
| `actions_log` | Audit of write actions; also feeds quota counting |
| `connection_log` | State transitions |

### 3.5 Customer details vs metadata only

**It stores customer details, not just metadata.** From `db.js` and `ingest.js` `parseMessage`:

- Full message **text/captions**, location text, contact display names and poll text.
- **Sender phone number** (`sender_phone`), **sender JID** and **WhatsApp display name** (`sender_name`, from `pushName`).
- `mentions`, `quoted_id`, `from_me`, timestamps, type, voice-note flag, edit and delete flags.
- Group **member lists** in `wa_groups.participants`: each member's JID/phone, LID and admin flag. Group subject, description and owner JID.
- Media metadata (mime, size, filename, duration) and `media_ref`.
- There is **no customer/contact table**. Customers exist only as sender fields on message rows and as group participants.
- Deleted messages are only flagged `deleted = true`; the stored `text` is **not cleared** (`ingest.js` revoke branch).

---

## 4. Message Processing

### 4.1 How incoming messages are captured

`session.js`, inside `#connect()`:

1. `sock.ev.on('messages.upsert', ({messages}) => ...)` (line 162). Every message in the batch is queued through `this.#queue()`, a promise chain that keeps ingestion ordered. The `type` field of the upsert (`notify`/`append`) is **not** filtered.
2. `ingestMessage(sock, msg)` (`ingest.js`) then does the following:
   - **Chat filter:** skips `status@broadcast`, any `@broadcast`, and `@newsletter`. It skips non-group chats unless `INCLUDE_DIRECT_CHATS=true`.
   - **Protocol messages:** revoke (type 0) sets `deleted = true` and emits `message.deleted`. Edit (type 14) updates `text` and `edited_at` and emits `message.updated`. Edit handling reads plain-text edits only (`conversation` / `extendedTextMessage`); a media caption edit would not change the stored text.
   - **Reactions:** upsert or delete in `reactions`; emits `reaction`.
   - **Everything else:** `parseMessage()` produces the row. It maps text, location, contact, poll, and media types (image, video, audio, document, sticker, ptv). Other content types are stored with `type` = content type minus the `Message` suffix and null text. Poll votes (`pollUpdateMessage`) would therefore be stored as an opaque `pollUpdate` row; votes are not decrypted or tallied.
   - **Sender resolution:** hidden `@lid` senders are resolved to a phone using the stored group participant list (`lookupLidPhone`). In 1:1 chats `remoteJidAlt` is used when present.
   - **Dedup and multi-number copies:** insert is `ON CONFLICT (number_id, chat_jid, id) DO NOTHING` inside `withLock` (advisory transaction lock). When two of your numbers are in the same group, the first copy stored is `primary_copy = true`; only the primary copy fires webhooks and appears in default lists.
   - **Emit:** `message.created` (primary copy and not from history).
3. **Own sent messages** are also ingested (`from_me = true`): `actions.js` `rawSend` calls `ingestMessage` after sending.

### 4.2 Baileys events used

| Event | Used for |
|---|---|
| `creds.update` | Persist login (`saveCreds`) |
| `connection.update` | QR, pairing, open, close and reconnect logic |
| `messages.upsert` | Live messages |
| `messaging-history.set` | History batch pushed by WhatsApp (ignored if `INGEST_HISTORY=false`) |
| `groups.upsert` | Upsert group metadata |
| `groups.update` | Re-fetch group metadata via `sock.groupMetadata` |
| `group-participants.update` | Re-fetch group metadata via `sock.groupMetadata` |

Besides events, `sock.groupFetchAllParticipating()` runs on every `open` (`#syncGroups`).

### 4.3 Permanent storage vs memory

- **Persisted:** all messages, reactions, groups, webhooks and deliveries (Postgres).
- **Memory only:** QR and pairing code, connection statuses, the restart/desired maps, the login-attempt limiter, the write queue and pacing state, and SSE client lists. SSE has **no replay**: a client that is offline misses events. Webhooks, by contrast, are persisted and retried.
- **Media:** with the default `MEDIA_MODE=ondemand`, no file is saved. Only `media_ref` is stored, and `GET /api/media/:uid` re-downloads from WhatsApp through the worker (`manager.fetchMediaFor` → IPC `media` → `fetchMedia` → `downloadMediaMessage`). Once WhatsApp expires the file, the API returns 410. With `MEDIA_MODE=store` the file is also saved to disk at ingest time (skipped if larger than `MAX_MEDIA_MB`, default 50).

### 4.4 Historical messages

- Only what WhatsApp pushes. On first link, `messaging-history.set` delivers recent history. `syncFullHistory: false` keeps it limited.
- History rows are stored with `from_history = true`, **no webhooks or SSE events**, and no media file saved. `media_ref` **is** still stored for history rows (`ingest.js` insert uses `parsed.ref` regardless), so history media may be re-downloadable until WhatsApp expires it.
- **No code path requests older history on demand.** No `fetchMessageHistory` call exists in the files read.
- Messages sent while the service is offline: the README says they "may be lost". Whether WhatsApp redelivers queued messages to a linked device on reconnect is WhatsApp/Baileys behaviour and was **not verified** here.
- Historical *queries* on already-stored data are supported through the API (`since`, `until`, `before_uid`, `after_uid`).

### 4.5 Groups vs individual chats

Yes. `isJidGroup` decides. **Default is groups only.** 1:1 chats are ignored unless `INCLUDE_DIRECT_CHATS=true`. When enabled, they are stored in the same `messages` table with `chat_jid` ending `@s.whatsapp.net` (or LID-mapped), and the "group name" is null because no `wa_groups` row exists. Status broadcasts, broadcast lists and channels are always ignored.

---

## 5. REST API

### 5.1 Authentication model (`auth.js`, `server.js`, `writes.js`)

| Credential | Accepted via | Grants |
|---|---|---|
| `API_KEY` | `x-api-key` header, `Authorization: Bearer`, or `?api_key=` query | All **read API** routes, plus webhook management and the transcript PUT |
| `ADMIN_API_KEY` (optional) | `x-api-key` / Bearer header only (not accepted in the query string) | Everything the API key can do, **plus** all write routes. If unset, writes return 403 "writing is disabled". |
| Portal cookie `wl_session` | `POST /portal/login {password}` | `/portal/*` routes and also the read API |

- Cookie: `<expiry>.<HMAC-SHA256(sessionSecret)>`, `HttpOnly`, `SameSite=Strict`, 12 h TTL, `Secure` only when `req.secure` (the app sets `trust proxy` to 1).
- Key and password comparisons use SHA-256 + `timingSafeEqual`.
- Login limiter: in memory, per IP; after 5 failures a 60 s lockout applies. **There is no rate limiting on API-key checks.**
- There are no per-user accounts, scopes, per-number key restrictions or CORS configuration.
- TLS is not handled by the app. Optional Caddy overlay (`docker-compose.caddy.yml`) provides HTTPS.
- Default bind: `HOST=0.0.0.0` in the app. `docker-compose.yml` publishes `127.0.0.1:${BIND}:3000` (localhost only unless `BIND` is set).

### 5.2 Public (no auth)

| Endpoint | Does / returns |
|---|---|
| `GET /health` | `{ok:true, whatsapp:<state or "n/m open">, numbers:{total, open}}`; 503 `{ok:false}` if the DB check fails |
| `GET /`, `/docs`, `/hexalog.css`, `/hexalog-logo.webp` | Static files from `public/`. Contents of `docs.html` not verified. |
| `POST /portal/login` | In: `{password}`. Out: `{ok:true}` plus cookie, or 401 / 429 |
| `POST /portal/logout` | Clears the cookie |

### 5.3 Portal routes (cookie required)

| Endpoint | In → Out |
|---|---|
| `GET /portal/me` | `{ok:true}` |
| `GET /portal/numbers`, `/portal/status` | `{numbers:[…], max}`; each number: `id, label, phone, state, linked, me{jid,name}, last_error, writes_enabled`, plus `qr` (data URL), `pairing_code`, `has_login` |
| `GET /portal/events` | SSE; same payload whenever `numbers.changed` fires; 25 s ping |
| `POST /portal/numbers` | `{label}` (≤ 60 chars, limited by `MAX_NUMBERS`) → number view |
| `PUT /portal/numbers/:id` | `{label}` → number view |
| `DELETE /portal/numbers/:id` | 409 unless the number is idle/logged_out, has no saved login and has **zero stored messages** |
| `POST /portal/numbers/:id/connect` | `{phone?}` → starts QR, or pairing code if `phone` is given |
| `POST /portal/numbers/:id/disconnect` | Pause (keeps login) |
| `POST /portal/numbers/:id/unlink` | Logs out of WhatsApp and wipes keys |

### 5.4 Read API (`API_KEY`, admin key header, or portal cookie)

All accept optional `?number=<id or phone>`. Without it, reads span all numbers and show only `primary_copy` messages.

| Endpoint | Accepts | Returns |
|---|---|---|
| `GET /api/status` | none | `{state, linked, me, last_error, numbers[]}` (the linked number's JID/phone is included) |
| `GET /api/numbers` | none | `{count, numbers[]}` |
| `GET /api/groups` | `search` | `{count, groups:[{jid, subject, description, participant_count, updated_at, numbers[], last_message_at, message_count}]}` |
| `GET /api/groups/:jid` | none | Full `wa_groups` row, **including `participants` (member JIDs, LIDs, admin flags)**, plus `numbers[]` |
| `GET /api/groups/:jid/messages`, `GET /api/messages` | `limit` (1-500, default 100), `after_uid`, `before_uid`, `since`, `until`, `type` (comma list), `sender` (phone), `search` (ILIKE on text) | `{count, next_after_uid, messages[]}`; DESC order, or ASC when `after_uid` is set |
| `GET /api/messages/:uid` | none | One message plus `reactions[{reactor_jid, emoji, ts}]` |
| `PUT /api/messages/:uid/transcript` | `{transcript: string}` | `{ok:true}`; updates the DB and emits `message.updated`. **This is a database write reachable with the read key.** |
| `GET /api/media/:uid` | none | Binary file (served from disk or re-downloaded from WhatsApp). Errors: 404 no media, 410 expired or missing, 413 over `MAX_MEDIA_MB`, 503 not connected |
| `GET /api/stream` | `number` | SSE events: `message.created`, `message.updated`, `message.deleted`, `reaction`, `group.updated`, `connection` |
| `GET /api/webhooks` | none | `{webhooks:[{id,url,events,active,created_at}], available_events}` |
| `POST /api/webhooks` | `{url (http/https), events?[], secret?}` | 201 `{id, url, events, secret, note}`. The secret is returned here; later listings omit it. |
| `DELETE /api/webhooks/:id` | none | `{ok:true}` |
| `GET /api/webhooks/:id/deliveries` | none | Last 100 deliveries: `id, event, status, attempts, last_error, created_at, delivered_at` |

**Message object** (`ingest.js` `publicRow`): `uid, number_id, id, chat_jid, group_name, sender_jid, sender_phone, sender_name, from_me, timestamp, type, text, quoted_id, mentions, is_voice_note, deleted, edited_at, transcript, media{url, stored, mime, size, filename, seconds, error}`.

**Are messages exposed through the API? Yes.** Full text, sender phone numbers and names, group member lists and media are all readable by any holder of the read key, and by any logged-in portal session.

**Webhooks** (`webhooks.js`):

- Events are queued into `webhook_deliveries` and POSTed by a 2 s dispatcher.
- Each request carries `x-walistener-event`, `x-walistener-delivery` and `x-walistener-signature: sha256=<HMAC of body>`.
- Timeout is 10 s. Retries use backoff (`min(1 h, 2^attempts × 5 s)`), up to `WEBHOOK_MAX_ATTEMPTS` (default 8).
- Any http(s) URL is accepted; there is no allow-list.
- `WEBHOOK_URL` / `WEBHOOK_SECRET` can auto-register one webhook at startup.

### 5.5 Write API (admin key, header only; `writes.js` → `manager.call` → worker `actions.js`)

The target number is chosen from `number` (body or query), or automatically from the message (`:uid`), the group (the single connected number in it), or the only connected number. If it is ambiguous the API returns 400 with the choices. Success: `{ok:true, number:<id>, …result}`. Failure: `{ok:false, error, …}`.

| Area | Endpoints |
|---|---|
| Send | `POST /api/send/text`, `/send/media` (base64 body), `/send/location`, `/send/contact`, `/send/poll` |
| Message actions | `POST /api/messages/:uid/react`, `/edit`, `/delete`, `/read`; `POST /api/presence`; `POST /api/lookup` (is this phone on WhatsApp) |
| Groups | `POST /api/groups` (create); `POST /api/groups/join`; `POST /api/groups/:jid/participants` (`add`/`remove`/`promote`/`demote`, optional `invite_fallback`); `PUT .../subject`, `.../description`, `.../settings`, `.../picture`; `DELETE .../picture`; `GET .../invite`; `POST .../invite/revoke`, `.../leave`, `.../refresh`; `GET/POST .../join-requests` |
| Profile | `PUT /api/profile/name`, `/status`, `/picture`; `DELETE /api/profile/picture` |
| Audit | `GET /api/actions?limit&number` → `actions_log` rows |

Guard rails in `actions.js`:

- One paced queue per worker: 1.5-4 s between messages, 5-10 s between group actions. Maximum 50 queued actions, then 429.
- Quotas counted from `actions_log`, so they survive restarts: 120 sends per hour, 10 group creations per day, 100 member adds/removes per day. All are configurable.
- Phone numbers are verified with `onWhatsApp` before adding or creating.
- Body limit is 1 MB everywhere, except the three file-carrying routes, which allow `MAX_MEDIA_MB × 1.4 + 1` MB.

---

## 6. QA Machine Behaviour

I could not verify how or on what OS your QA machine runs this (Docker or plain `npm start`), so both paths are described from the code.

### 6.1 What happens when you run it

**Docker (`docker compose up -d --build`):**

1. The compose file requires a `.env` file in the project folder (`env_file: .env`).
2. It builds the image (`npm ci --omit=dev`, copies `src` and `public` only).
3. It starts `postgres:16-alpine` and the app.
4. It creates Docker named volumes `pgdata` and `appdata`. These live in Docker's storage area, **outside the project folder**.
5. It publishes `127.0.0.1:3000` by default.
6. The container healthcheck calls `/health` every 30 s.
7. With the Caddy overlay it also binds host ports 80 and 443 and creates volumes `caddy_data` and `caddy_config`.

**Plain Node (`npm start`):**

1. It needs a reachable Postgres via `DATABASE_URL`. Otherwise it tries the localhost fallback described in 3.4.
2. It creates `./data` relative to the **current working directory**.
3. It runs schema migrations on whatever database `DATABASE_URL` points to.
4. It listens on `0.0.0.0:3000` by default (`HOST` default), so it is reachable from the machine's network unless a firewall blocks it.
5. It spawns one `node src/worker.js` child per auto-connecting number.

### 6.2 Directories created

See 3.1: `DATA_DIR`, `DATA_DIR/auth/<id>/`, and `DATA_DIR/media/<date>/` (store mode only). Inside Docker these are under `/data` (volume `appdata`).

### 6.3 Anything outside the project directory?

- **The app code itself** writes only under `DATA_DIR` and to Postgres. If `DATA_DIR` is set to an absolute path, that is where it writes. It reads `public/` from the code folder.
- **Docker** stores images and volumes in its own area, and may bind host ports 3000, and 80/443 with Caddy.
- **The deploy scripts are not run by the app**, but if you run them they do system-level work:
  - `deploy/setup.sh` needs root. It can install Docker (`curl https://get.docker.com | sh`), create `/swapfile` and edit `/etc/fstab` on low-memory machines, and write `.env` (mode 600) with random secrets, **printing the portal password to the terminal**.
  - `deploy/backup.sh` writes to `/var/backups/wa-listener`.
  - `deploy/update.sh` runs `git pull --ff-only` and rebuilds.

### 6.4 External communication

- **WhatsApp servers:** WebSocket connection by Baileys, plus media CDN downloads via `downloadMediaMessage`.
- **Version lookup:** `fetchLatestBaileysVersion()` makes an outbound request. Its destination is defined inside Baileys and was not verified.
- **Webhook targets** you register (and the optional `WEBHOOK_URL`): HTTPS or HTTP POSTs with message payloads.
- **Build time:** the npm registry and Docker Hub. With Caddy: Let's Encrypt/ACME (Caddy's behaviour).
- **`setup.sh`:** the AWS metadata endpoint (169.254.169.254), `get.docker.com` and GitHub.
- **Browser side:** `public/index.html` loads Google Fonts from the user's browser. The server does not.
- No analytics or telemetry code was found in the files read.

### 6.5 What happens on restart

1. `SIGTERM`/`SIGINT` trigger `manager.shutdown()`: each worker is asked to stop, then killed; the DB pool closes.
2. On the next start, `migrate()` is idempotent and pending webhook deliveries in the DB are resumed by the dispatcher.
3. `manager.init()` auto-reconnects every number that has `auto_connect = true` and a saved `creds.json`, with **no new QR**. `AUTO_CONNECT=false` disables this.
4. **Lost on restart (memory only):** QR and pairing code, statuses (shown as `idle` until a worker reports), restart counters, login-limiter state, queued write actions and SSE connections.
5. **Messages arriving while the app is down:** not handled in code (see 4.4).
6. **If the `auth` folder or volume is lost** (for example a container without a persistent volume), the number must be re-linked by QR.
7. **A paused number comes back after a restart.** "Pause listening" (`manager.stop`) only removes the number from the in-memory `desired` set. No code ever updates `numbers.auto_connect`, so the next start reconnects it.
8. **A worker crash** is restarted automatically with backoff. A number that WhatsApp logged out stays `logged_out` and its keys are already deleted.

---

## 7. Current Capabilities and Limitations

### 7.1 Implemented (verified in code)

- Multi-number operation: one isolated worker process per number, with auto-restart, reconnect backoff and staggered startup.
- Portal login, QR and pairing-code linking, pause, unlink, rename and delete of numbers.
- Group message capture for text, media, location, contact and poll, plus replies, mentions, edits, deletes and reactions.
- Group metadata and member list sync, including LID → phone resolution.
- Postgres schema with auto-migration and multi-number duplicate handling (`primary_copy`).
- Read REST API with cursor pagination and filters, SSE stream and HMAC-signed webhooks with retries and a delivery log.
- On-demand media re-download, or optional disk storage with `MEDIA_MODE=store`.
- Transcript write-back endpoint.
- Optional write API (send, groups, profile), gated by a separate admin key, with pacing, quotas, audit log and number verification.
- Deployment assets: Dockerfile, compose, Caddy overlay, Render blueprint, EC2 setup/update/backup scripts.
- Test files exist for smoke, writes and multi-number scenarios (`test/*.js`). They were not run or read, and they need `TEST_DATABASE_URL`.

### 7.2 Partially implemented

- **History:** only what WhatsApp pushes at link time, with no webhooks or media saved for it, and no on-demand backfill.
- **Media:** by default retrievable only until WhatsApp expires the file (410 afterwards). `media_ref` holds decryption keys in the database.
- **Deleted messages:** flagged but the original text stays in the database.
- **Edits:** plain-text edits only.
- **Poll votes:** stored as opaque `pollUpdate` rows, not tallied.
- **Direct chats:** opt-in (`INCLUDE_DIRECT_CHATS`), with no contact model.
- **Voice-note transcription:** the service stores the audio reference and exposes the write-back endpoint, but speech-to-text itself is external.
- **Access control:** two shared static keys plus one portal password; no per-user identity, scopes or per-number restrictions. The read key can manage webhooks and write transcripts.
- **Backups:** a script exists, but scheduling and encryption are manual.
- **Monitoring:** only `/health` and the `connection` event.

### 7.3 Not implemented (no code found)

- Data retention or purge, encryption at rest for keys and the DB, and any customer/contact/CRM entity.
- Rate limiting on API-key authentication; CORS configuration; in-app TLS.
- On-demand history fetch, and any recovery path for messages missed while offline.
- Inbox features (assignment, status, tags, notes, agent UI). Those belong to the separate CX Inbox project.
- Automatic alerting on disconnect.
- Persisting "paused" state across restarts.

### 7.4 Documentation drift noticed

- `README.md` "Things to know" says "Media is downloaded the instant a message arrives". In code, that happens only with `MEDIA_MODE=store`. The default is on-demand.
- The Project document `claude/wa-listener-service.md` describes an earlier shape of the service: read-only, single number, media always stored. The current code has the admin write API, multi-number workers and on-demand media. `claude/cx-inbox-technical-overview.md` describes a different codebase (JSON store, Socket.io).

### 7.5 Items I could not verify

- Runtime behaviour, test results and the contents of any real `.env`.
- Baileys internals (auth file layout, version-fetch URL, temp-file usage).
- `public/docs.html` content and `scripts/api_tester/`.
- Your QA machine's OS and how you start the service.
- Whether WhatsApp redelivers messages sent while the service was offline.
