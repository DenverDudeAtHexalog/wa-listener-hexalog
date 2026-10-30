import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
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

CREATE TABLE IF NOT EXISTS connection_log (
  id     bigserial PRIMARY KEY,
  ts     timestamptz NOT NULL DEFAULT now(),
  state  text NOT NULL,
  detail text
);
`;

export async function migrate() {
  await q(SCHEMA);
}
