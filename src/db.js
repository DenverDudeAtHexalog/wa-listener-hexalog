import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: config.dbPoolMax });
pool.on('error', (e) => console.error('[db] idle client error', e.message));

export const q = (text, params) => pool.query(text, params);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS wa_groups (
  jid            text PRIMARY KEY,
  subject        text,
  description    text,
  owner_jid      text,
  created_at_wa  timestamptz,
  participants   jsonb NOT NULL DEFAULT '[]',
  participant_count integer NOT NULL DEFAULT 0,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  uid            bigserial PRIMARY KEY,
  id             text NOT NULL,
  chat_jid       text NOT NULL,
  sender_jid     text,
  sender_phone   text,
  sender_name    text,
  from_me        boolean NOT NULL DEFAULT false,
  ts             timestamptz NOT NULL,
  type           text NOT NULL,
  text           text,
  quoted_id      text,
  mentions       jsonb,
  media_path     text,
  media_mime     text,
  media_size     bigint,
  media_filename text,
  media_seconds  integer,
  media_error    text,
  is_voice_note  boolean NOT NULL DEFAULT false,
  transcript     text,
  deleted        boolean NOT NULL DEFAULT false,
  edited_at      timestamptz,
  from_history   boolean NOT NULL DEFAULT false,
  inserted_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chat_jid, id)
);
CREATE INDEX IF NOT EXISTS messages_chat_ts_idx ON messages (chat_jid, ts DESC, uid DESC);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_ref jsonb;
CREATE INDEX IF NOT EXISTS messages_ts_idx ON messages (ts DESC);
CREATE INDEX IF NOT EXISTS messages_type_idx ON messages (type);

CREATE TABLE IF NOT EXISTS reactions (
  chat_jid   text NOT NULL,
  message_id text NOT NULL,
  reactor_jid text NOT NULL,
  emoji      text NOT NULL,
  ts         timestamptz NOT NULL,
  PRIMARY KEY (chat_jid, message_id, reactor_jid)
);

CREATE TABLE IF NOT EXISTS webhooks (
  id         bigserial PRIMARY KEY,
  url        text NOT NULL,
  secret     text NOT NULL,
  events     text[] NOT NULL DEFAULT '{}',
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id           bigserial PRIMARY KEY,
  webhook_id   bigint NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event        text NOT NULL,
  payload      jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'pending',
  attempts     integer NOT NULL DEFAULT 0,
  next_attempt timestamptz NOT NULL DEFAULT now(),
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);
CREATE INDEX IF NOT EXISTS deliveries_due_idx ON webhook_deliveries (status, next_attempt);

CREATE TABLE IF NOT EXISTS actions_log (
  id      bigserial PRIMARY KEY,
  ts      timestamptz NOT NULL DEFAULT now(),
  kind    text NOT NULL,
  action  text NOT NULL,
  target  text,
  summary jsonb,
  ok      boolean NOT NULL,
  error   text,
  cost    integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS actions_log_kind_ts_idx ON actions_log (kind, ts DESC);

CREATE TABLE IF NOT EXISTS connection_log (
  id     bigserial PRIMARY KEY,
  ts     timestamptz NOT NULL DEFAULT now(),
  state  text NOT NULL,
  detail text
);

-- ---- multiple numbers ------------------------------------------------------------------------------
-- Every WhatsApp number we run is a row here. Existing single-number data becomes number 1.
CREATE TABLE IF NOT EXISTS numbers (
  id           serial PRIMARY KEY,
  label        text NOT NULL,
  phone        text UNIQUE,
  auto_connect boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);
INSERT INTO numbers (id, label) SELECT 1, 'Number 1' WHERE NOT EXISTS (SELECT 1 FROM numbers);
SELECT setval(pg_get_serial_sequence('numbers', 'id'), GREATEST((SELECT max(id) FROM numbers), 1));

ALTER TABLE messages       ADD COLUMN IF NOT EXISTS number_id integer NOT NULL DEFAULT 1;
-- When two of our numbers are in the same group, each stores a copy; only the first copy is the primary one
-- (shown in lists and announced by webhooks).
ALTER TABLE messages       ADD COLUMN IF NOT EXISTS primary_copy boolean NOT NULL DEFAULT true;
ALTER TABLE wa_groups      ADD COLUMN IF NOT EXISTS number_id integer NOT NULL DEFAULT 1;
ALTER TABLE actions_log    ADD COLUMN IF NOT EXISTS number_id integer NOT NULL DEFAULT 1;
ALTER TABLE connection_log ADD COLUMN IF NOT EXISTS number_id integer NOT NULL DEFAULT 1;

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_chat_jid_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS messages_number_chat_id_uq ON messages (number_id, chat_jid, id);
CREATE INDEX IF NOT EXISTS messages_copy_idx ON messages (chat_jid, id);
CREATE INDEX IF NOT EXISTS messages_primary_uid_idx ON messages (uid DESC) WHERE primary_copy;
CREATE INDEX IF NOT EXISTS actions_log_number_idx ON actions_log (number_id, kind, ts DESC);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'wa_groups'::regclass AND contype = 'p' AND array_length(conkey, 1) = 1) THEN
    ALTER TABLE wa_groups DROP CONSTRAINT wa_groups_pkey;
    ALTER TABLE wa_groups ADD PRIMARY KEY (number_id, jid);
  END IF;
END $$;

-- ---- team inbox: people, who owns a chat, notes ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            serial PRIMARY KEY,
  username      text UNIQUE NOT NULL,
  name          text NOT NULL,
  role          text NOT NULL DEFAULT 'agent',   -- agent | admin
  password_hash text NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS chat_state (
  chat_jid    text PRIMARY KEY,
  status      text NOT NULL DEFAULT 'open',      -- open | pending | resolved
  assignee_id integer,
  labels      text[] NOT NULL DEFAULT '{}',
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);
CREATE TABLE IF NOT EXISTS chat_notes (
  id         serial PRIMARY KEY,
  chat_jid   text NOT NULL,
  kind       text NOT NULL DEFAULT 'note',       -- note (written by a person) | event (assigned, resolved...)
  user_name  text NOT NULL,
  text       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_notes_chat_idx ON chat_notes (chat_jid, id);
CREATE TABLE IF NOT EXISTS chat_reads (
  user_key text NOT NULL,                        -- 'o' for the owner login, 'u<id>' for a person
  chat_jid text NOT NULL,
  last_uid bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (user_key, chat_jid)
);
CREATE TABLE IF NOT EXISTS quick_replies (
  id         serial PRIMARY KEY,
  title      text NOT NULL,
  body       text NOT NULL,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sent_by_name text;
-- Every chat we have seen a message in (groups and 1:1), so the chat list does not have to scan all messages.
CREATE TABLE IF NOT EXISTS chat_known (
  chat_jid   text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO chat_known (chat_jid) SELECT DISTINCT chat_jid FROM messages WHERE NOT EXISTS (SELECT 1 FROM chat_known) ON CONFLICT DO NOTHING;
CREATE INDEX IF NOT EXISTS messages_chat_uid_idx ON messages (chat_jid, uid DESC);
-- Names WhatsApp gives us for people (saved contact name, or the name they set for themselves).
CREATE TABLE IF NOT EXISTS contacts (
  number_id  integer NOT NULL DEFAULT 1,
  jid        text NOT NULL,
  name       text,
  notify     text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (number_id, jid)
);
`;

export async function migrate() {
  // Several processes may start at once; serialise the schema change.
  const c = await pool.connect();
  try {
    await c.query('SELECT pg_advisory_lock(727001)');
    await c.query(SCHEMA);
  } finally {
    await c.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
    c.release();
  }
}

/** Run fn inside a transaction holding an advisory lock for `key` (so two numbers don't both claim the same message). */
export async function withLock(key, fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
