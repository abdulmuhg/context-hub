import { existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { openDb } from './db.js';
import { createHandler } from './http.js';
import { AnthropicLlm, DEFAULT_MODEL, type Effort } from './llm-anthropic.js';
import { handleMcp } from './mcp.js';
import { parsePublicUrl } from './oauth/config.js';
import { DEFAULT_MAX_INPUT_TOKENS, startWorker } from './worker.js';
import type { WebConfig } from './web/routes.js';

const path = process.env.DATABASE_PATH ?? './data/hub.sqlite';
const port = Number(process.env.PORT ?? 3000);

mkdirSync(dirname(path), { recursive: true });
const db = openDb(path);
const rawPublicUrl = process.env.PUBLIC_URL?.trim();
const publicUrl = rawPublicUrl ? parsePublicUrl(rawPublicUrl) : undefined;

// The compose file mounts the backup status folder read-only; without it the dashboard
// simply says there is no status yet.
const DEFAULT_BACKUP_STATUS = '/backup-status/context-hub.json';
const backupStatus = process.env.BACKUP_STATUS_PATH?.trim();
const web: WebConfig = {
  imageTag: process.env.IMAGE_TAG?.trim() || null,
  startedAt: new Date().toISOString(),
  digestsOn: Boolean(process.env.ANTHROPIC_API_KEY),
  backupStatusPath: backupStatus || (existsSync(DEFAULT_BACKUP_STATUS) ? DEFAULT_BACKUP_STATUS : null),
  // Without a public URL (or on a local one) the browser is on plain http, where a Secure cookie is dropped.
  secureCookies: publicUrl !== undefined && !publicUrl.startsWith('http://localhost'),
  publicOrigin: publicUrl ?? null,
};

const server = createServer(createHandler({ db, mcp: handleMcp(db), web, ...(publicUrl ? { oauth: { publicUrl } } : {}) }));
console.log(publicUrl ? `oauth: on, ${publicUrl}` : 'oauth: off, no PUBLIC_URL');
console.log(`dashboard: on, secure cookies ${web.secureCookies ? 'on' : 'off'}, backup status ${web.backupStatusPath ?? 'none'}`);

const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
let worker: { stop: () => Promise<void> } | null = null;

if (process.env.ANTHROPIC_API_KEY) {
  const effort = (process.env.DIGEST_EFFORT ?? 'low') as Effort;
  if (!EFFORTS.includes(effort)) throw new Error(`DIGEST_EFFORT must be one of: ${EFFORTS.join(', ')}`);
  const maxInputTokens = Number(process.env.DIGEST_MAX_INPUT_TOKENS ?? DEFAULT_MAX_INPUT_TOKENS);
  if (!Number.isInteger(maxInputTokens) || maxInputTokens < 1000) throw new Error('DIGEST_MAX_INPUT_TOKENS must be a whole number of at least 1000');
  const model = process.env.DIGEST_MODEL ?? DEFAULT_MODEL;
  worker = startWorker({ db, llm: new AnthropicLlm({ model, effort }), maxInputTokens });
  console.log(`digests: on, model ${model}, effort ${effort}`);
} else {
  console.log('digests: off, no ANTHROPIC_API_KEY. Uploads and lookups work; digests stay queued until a key is set.');
}

server.listen(port, () => console.log(`context-hub listening on :${port}, database ${path}`));

const stop = (): void => {
  server.closeAllConnections();
  server.close(async () => {
    await worker?.stop(); // lets a digest that is mid-call finish and be saved
    db.close();
    process.exit(0);
  });
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
