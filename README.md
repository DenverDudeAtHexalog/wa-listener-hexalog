# WhatsApp Listener

Headless, read-only WhatsApp group listener built on Baileys. One number is linked once through a login
portal; it then records every message in the groups it has been added to (text, images, video, documents,
voice notes, replies, edits, deletes, reactions) and exposes them through a REST API, signed webhooks and a
live event stream.

It never sends messages and never sends read receipts.

## Run it

```bash
cp .env.example .env      # set API_KEY, PORTAL_PASSWORD, DB_PASSWORD, PUBLIC_BASE_URL
docker compose up -d --build
```

Open `http://<host>:3000`, sign in with `PORTAL_PASSWORD`, then either **Link with QR code** or enter the
number to get a **pairing code**. Linking is a one-time step; the login keys are kept in the `appdata`
volume and the service reconnects by itself after restarts.

Without Docker: Node 20+, a Postgres database, `npm install`, set the env vars in `.env.example`, `npm start`.

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
| `GET /api/media/:uid` | The stored file (image, video, document, voice note) |
| `PUT /api/messages/:uid/transcript` | Attach a transcript from your speech-to-text worker. Body: `{"transcript":"..."}` |
| `GET /api/stream` | Server-Sent Events: `message.created`, `message.updated`, `message.deleted`, `reaction`, `group.updated`, `connection` |
| `GET/POST/DELETE /api/webhooks` | Manage webhooks. `GET /api/webhooks/:id/deliveries` shows delivery status |

Message filters: `limit` (max 500), `after_uid` (everything newer than a cursor, oldest first; use the returned
`next_after_uid`), `before_uid`, `since`, `until` (ISO times), `type` (comma list: text, image, video, audio,
document, sticker, location, contact, poll), `sender` (phone number), `search` (text).

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
