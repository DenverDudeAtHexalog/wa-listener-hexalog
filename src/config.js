import path from 'node:path';

const env = process.env;
const int = (v, d) => (v === undefined || v === '' ? d : parseInt(v, 10));

export const config = {
  port: int(env.PORT, 3000),
  host: env.HOST || '0.0.0.0',
  // Which WhatsApp number this process serves. The API process uses 1 only in inline mode; workers get NUMBER_ID from it.
  numberId: int(env.NUMBER_ID, 1),
  // 'fork' (default): one isolated worker process per number.  'inline': number 1 runs inside the API process (used by tests).
  workerMode: env.WORKER_MODE === 'inline' ? 'inline' : 'fork',
  workerMaxMb: int(env.WORKER_MAX_MB, 256),   // heap cap per worker process
  maxNumbers: int(env.MAX_NUMBERS, 30),
  dbPoolMax: int(env.DB_POOL_MAX, 10),
  databaseUrl: env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/walistener',
  dataDir: path.resolve(env.DATA_DIR || './data'),
  // Auth: API key for machine access, portal password for humans
  apiKey: env.API_KEY || '',
  portalPassword: env.PORTAL_PASSWORD || '',
  sessionSecret: env.SESSION_SECRET || env.API_KEY || '',
  publicBaseUrl: (env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
  // Listener behaviour
  // 'ondemand' (default): store only the info needed to re-download a file and fetch it from WhatsApp when opened.
  // 'store': also save every file on this server's disk (needs disk space; files survive WhatsApp expiring them).
  mediaMode: env.MEDIA_MODE === 'store' ? 'store' : 'ondemand',
  maxMediaMb: int(env.MAX_MEDIA_MB, 50),
  includeDirectChats: env.INCLUDE_DIRECT_CHATS === 'true',
  ingestHistory: env.INGEST_HISTORY !== 'false',
  autoConnect: env.AUTO_CONNECT !== 'false',
  logLevel: env.LOG_LEVEL || 'warn',
  // Writing (sending messages, managing groups). Disabled unless ADMIN_API_KEY is set.
  adminApiKey: env.ADMIN_API_KEY || '',
  msgGapMinMs: int(env.MSG_GAP_MIN_MS, 1500),      // pause between outgoing messages (random between min and max)
  msgGapMaxMs: int(env.MSG_GAP_MAX_MS, 4000),
  groupGapMinMs: int(env.GROUP_GAP_MIN_MS, 5000),  // pause between group-management actions
  groupGapMaxMs: int(env.GROUP_GAP_MAX_MS, 10000),
  maxSendsPerHour: int(env.MAX_SENDS_PER_HOUR, 120),
  maxGroupCreatesPerDay: int(env.MAX_GROUP_CREATES_PER_DAY, 10),
  maxMemberChangesPerDay: int(env.MAX_MEMBER_CHANGES_PER_DAY, 100), // members added or removed
  writeQueueMax: int(env.WRITE_QUEUE_MAX, 50),
  // Webhooks
  webhookMaxAttempts: int(env.WEBHOOK_MAX_ATTEMPTS, 8),
  defaultWebhookUrl: env.WEBHOOK_URL || '',
  defaultWebhookSecret: env.WEBHOOK_SECRET || '',
};

export function assertConfig() {
  const problems = [];
  if (!config.apiKey) problems.push('API_KEY is required');
  if (!config.portalPassword) problems.push('PORTAL_PASSWORD is required');
  if (!config.sessionSecret) problems.push('SESSION_SECRET (or API_KEY) is required');
  if (config.adminApiKey && config.adminApiKey === config.apiKey) problems.push('ADMIN_API_KEY must differ from API_KEY');
  if (problems.length) {
    throw new Error('Invalid configuration: ' + problems.join('; '));
  }
}

/** Where one number's WhatsApp login keys live. */
export const authDirFor = (id) => path.join(config.dataDir, 'auth', String(id));
