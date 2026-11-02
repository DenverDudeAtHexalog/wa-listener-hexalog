# WhatsApp Listener

WhatsApp group listener built on Baileys. One number is linked once through a login portal; it then records every
message in the groups it has been added to (text, images, video, documents, voice notes, replies, edits, deletes,
reactions) and exposes them through a REST API, signed webhooks and a live event stream.

By default it is listen-only. Set `ADMIN_API_KEY` to also let your systems send messages and manage groups
through the API (see "Writing" below).

## Run it

```bash
cp .env.example .env      # set API_KEY, PORTAL_PASSWORD, DB_PASSWORD, PUBLIC_BASE_URL
docker compose up -d --build
```

Open `http://<host>:3000`, sign in with `PORTAL_PASSWORD`, then either **Link with QR code** or enter the
number to get a **pairing code**. Linking is a one-time step; the login keys are kept in the `appdata`
volume and the service reconnects by itself after restarts.

Without Docker: Node 20+, a Postgres database, `npm install`, set the env vars in `.env.example`, `npm start`.

### Deploy on an AWS EC2 box

Works on Ubuntu/Debian or Amazon Linux 2023, x86 or ARM; 2 GB RAM is comfortable (1 GB works, a swap file is added).
Get the code onto the machine (`git clone` or copy the zip), then from the repo folder:

```bash
sudo bash deploy/setup.sh                              # private: reach the portal through an SSH tunnel
sudo DOMAIN=listener.example.com bash deploy/setup.sh  # public HTTPS via Caddy (point a DNS A record at the server first)
```

It installs Docker, creates `.env` with random secrets (printed once), builds and starts everything, and waits for
`/health`. Security group: open 22 from your IP only; add 80 and 443 only if you use a domain. Never expose port 3000
to the whole internet over plain HTTP. Data lives in Docker volumes (`appdata` = login keys + media, `pgdata`).
Redeploy with `sudo bash deploy/update.sh`; schedule `deploy/backup.sh` in cron for nightly backups.

### Deploy on Render

`render.yaml` defines the web service (Docker, Starter plan, 5 GB persistent disk at `/data`) and a Postgres
database, both in Singapore. In Render: **New → Blueprint**, pick this repo, enter `PORTAL_PASSWORD` and
`PUBLIC_BASE_URL` when asked, and apply. `API_KEY` and `SESSION_SECRET` are generated for you (read `API_KEY`
from the service's Environment tab). Keep it at one instance. Free plans cannot be used: they have no disk and
spin down after 15 minutes, which would drop the WhatsApp connection.

**Hosting:** needs an always-on process with persistent disk (VPS, Railway, Fly.io, Render with a disk).
It cannot run on Vercel or other serverless platforms.

## API

Send `x-api-key: <API_KEY>` (or `Authorization: Bearer <API_KEY>`, or `?api_key=` for media and event streams).

| Endpoint | Purpose |
|---|---|
| `GET /api/status` | Connection state and linked number |
| `GET /api/groups?search=` | Groups the number is in, with last message time and message count |
| `GET /api/groups/:jid/messages` | Messages of one group (URL-encode the jid) |
| `GET /api/messages` | Messages across all groups |
| `GET /api/messages/:uid` | One message, including reactions |
| `GET /api/media/:uid` | The file (image, video, document, voice note). Fetched from WhatsApp when opened, see "Files" below |
| `PUT /api/messages/:uid/transcript` | Attach a transcript from your speech-to-text worker. Body: `{"transcript":"..."}` |
| `GET /api/stream` | Server-Sent Events: `message.created`, `message.updated`, `message.deleted`, `reaction`, `group.updated`, `connection` |
| `GET/POST/DELETE /api/webhooks` | Manage webhooks. `GET /api/webhooks/:id/deliveries` shows delivery status |

Message filters: `limit` (max 500), `after_uid` (everything newer than a cursor, oldest first; use the returned
`next_after_uid`), `before_uid`, `since`, `until` (ISO times), `type` (comma list: text, image, video, audio,
document, sticker, location, contact, poll), `sender` (phone number), `search` (text).

### Writing (sending and group management)

Everything that changes something on WhatsApp needs the **admin key** in the `x-api-key` header (never in a URL).
It is disabled until `ADMIN_API_KEY` is set (it must differ from `API_KEY`). The normal `API_KEY` can only read.
Phone numbers are digits with country code (`919800000001`); a full JID such as `1203...@g.us` also works.

| Endpoint | Does |
|---|---|
| `POST /api/send/text` `{to, text, mentions?, reply_to_uid?}` | Send text. Put `@919800000002` in the text and the number in `mentions` to tag someone |
| `POST /api/send/media` `{to, type, data_base64, caption?, filename?, mimetype?, voice_note?, reply_to_uid?}` | `type` = image, video, audio, document, sticker. Voice notes: `type:"audio", voice_note:true` with an ogg/opus file |
| `POST /api/send/location` `{to, latitude, longitude, name?, address?}` | Location |
| `POST /api/send/contact` `{to, contacts:[{name, phone}]}` | Contact card |
| `POST /api/send/poll` `{to, question, options, multi?}` | Poll |
| `POST /api/messages/:uid/react` `{emoji}` | React (empty emoji removes it) |
| `POST /api/messages/:uid/edit` `{text}` / `.../delete` / `.../read` | Edit or delete your own message; mark read |
| `POST /api/presence` `{to, state}` | Typing indicator (`composing`, `recording`, `paused`) |
| `POST /api/lookup` `{numbers}` | Which numbers are on WhatsApp |
| `POST /api/groups` `{subject, participants}` | Create a group |
| `POST /api/groups/:jid/participants` `{action, participants, invite_fallback?, invite_message?}` | `add`, `remove`, `promote` (make admin), `demote`. Per-person results; `invite_fallback` DMs the invite link to people whose privacy settings block adding |
| `PUT /api/groups/:jid/subject` / `description` | Rename, set description |
| `PUT /api/groups/:jid/settings` `{announce?, locked?, member_add_mode?, join_approval?, ephemeral_seconds?}` | Only admins can send, only admins can edit info, who can add members (`admin`/`all`), approval to join, disappearing messages |
| `PUT /api/groups/:jid/picture` `{data_base64}` / `DELETE` | Group icon |
| `GET /api/groups/:jid/invite`, `POST .../invite/revoke` | Invite link; reset it |
| `POST /api/groups/join` `{invite}` | Join a group from a link |
| `POST /api/groups/:jid/leave`, `/refresh` | Leave; re-read members |
| `GET/POST /api/groups/:jid/join-requests` | List requests; `{action:"approve"|"reject", participants}` |
| `PUT /api/profile/name`, `/status`, `/picture`, `DELETE /api/profile/picture` | The linked number's own profile |
| `GET /api/actions` | Audit log of every action done through the API |

Messages the number sends are stored like any other (`from_me: true`). Group actions only work where the linked
number is an admin; otherwise the API answers `403`. Adding people needs them to be on WhatsApp (checked first) and to
allow being added by non-contacts, otherwise use `invite_fallback`.

**Safety.** Automated sending and group management is the fastest way to get a WhatsApp number banned, so every action goes
through one queue with random pauses (1.5 to 4 s between messages, 5 to 10 s between group actions) and limits that return `429`
when reached: 120 messages per hour, 10 new groups per day and 100 members added or removed per day (all configurable). Use an
established number, only message people who expect it, and keep bulk work small.

### Message object

```json
{
  "uid": 42, "id": "3EB0...", "chat_jid": "1203630...@g.us", "group_name": "Acme - CX",
  "sender_jid": "919800000001@s.whatsapp.net", "sender_phone": "919800000001", "sender_name": "Asha",
  "timestamp": "2026-10-30T10:15:00.000Z", "type": "audio", "text": null, "quoted_id": null,
  "is_voice_note": true, "deleted": false, "edited_at": null, "transcript": null,
  "media": { "url": "https://listener.example.com/api/media/42", "mime": "audio/ogg; codecs=opus",
             "size": 18234, "filename": null, "seconds": 7, "error": null }
}
```

### Webhooks

`POST /api/webhooks {"url":"https://you/hook","events":["message.created"]}` (empty `events` = all). The response
shows the signing secret once. Each delivery is a JSON body with header `X-Walistener-Signature: sha256=<HMAC-SHA256
of the raw body using the secret>`. Failed deliveries retry with backoff (10s up to 1h, 8 attempts).

### Files (photos, documents, voice notes)

By default (`MEDIA_MODE=ondemand`) no files are saved on the server. For each file the service stores only the small
amount of information needed to download it from WhatsApp, and `GET /api/media/:uid` fetches it from WhatsApp at that
moment. This keeps the disk small, but WhatsApp does not keep files forever: once a file has expired there, the
request returns `410 this file is no longer available from WhatsApp` and it cannot be recovered. A file always works
right after it arrives, so anything that must be kept (for example a speech-to-text worker, or an archive job) should
fetch it when the `message.created` webhook fires. Requests return `503` while the number is disconnected.

Set `MEDIA_MODE=store` to save every file on the server's disk as well (files then survive WhatsApp expiring them, but
the disk fills over time). Files saved earlier in `store` mode keep being served from disk.

### Voice notes

The audio file is saved as received (ogg/opus). Run speech-to-text outside this service (triggered by the
`message.created` webhook where `is_voice_note` is true), then write the result back with
`PUT /api/messages/:uid/transcript`.

## Things to know

- The number only sees messages from the moment it is added to a group. Messages sent while the service is
  down may be lost. Run it 24/7 and alert on `/health` or the `connection` event.
- Group admins must add the number to each group.
- Media is downloaded the instant a message arrives; files larger than `MAX_MEDIA_MB` are skipped and the
  message carries `media.error`.
- Back up the `appdata` volume (login keys + media) and the Postgres volume. Anyone with the keys can act as
  that number.
- This uses WhatsApp's unofficial linked-device protocol. Use a dedicated number, never send from it, and keep a
  spare number ready. Update Baileys (`npm update baileys`) if WhatsApp changes its protocol.
- Tell group members that messages are recorded (DPDP Act, India).

## Tests

`TEST_DATABASE_URL=postgres://... npm test` runs an end-to-end smoke test with synthetic messages.
