import path from 'node:path';

const env = process.env;
const int = (v, d) => (v === undefined || v === '' ? d : parseInt(v, 10));

export const config = {
  port: int(env.PORT, 3000),
  host: env.HOST || '0.0.0.0',
  databaseUrl: env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/walistener',
  dataDir: path.resolve(env.DATA_DIR || './data'),
  // Auth: API key for machine access, portal password for humans
  apiKey: env.API_KEY || '',
  portalPassword: env.PORTAL_PASSWORD || '',
  sessionSecret: env.SESSION_SECRET || env.API_KEY || '',
  publicBaseUrl: (env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
  // Listener behaviour
  maxMediaMb: int(env.MAX_MEDIA_MB, 50),
  includeDirectChats: env.INCLUDE_DIRECT_CHATS === 'true',
  ingestHistory: env.INGEST_HISTORY !== 'false',
  autoConnect: env.AUTO_CONNECT !== 'false',
  logLevel: env.LOG_LEVEL || 'warn',
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
  if (problems.length) {
    throw new Error('Invalid configuration: ' + problems.join('; '));
  }
}
