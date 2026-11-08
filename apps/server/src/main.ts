import { existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { createPageviewCapture } from './analytics.js';
import { loadClientBundle } from './client-dist.js';
import { openDb } from './db.js';
import { logger, parseLogLevel } from './logger.js';
import { createHandler } from './http.js';
import { AnthropicLlm, DEFAULT_MODEL, type Effort } from './llm-anthropic.js';
import { handleMcp } from './mcp.js';
import { parsePublicUrl } from './oauth/config.js';
import { parseDailyBudgetUsd, recordUsage } from './usage.js';
import { DEFAULT_MAX_INPUT_TOKENS, startWorker } from './worker.js';
import { secureCookiesFor, type WebConfig } from './web/routes.js';

logger.setLevel(parseLogLevel(process.env.LOG_LEVEL));

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
const dailyBudgetUsd = parseDailyBudgetUsd(process.env.DIGEST_DAILY_BUDGET_USD);
const pageview = createPageviewCapture({ key: process.env.POSTHOG_KEY, host: process.env.POSTHOG_HOST });
const posthogOn = Boolean(process.env.POSTHOG_KEY?.trim());
const web: WebConfig = {
  imageTag: process.env.IMAGE_TAG?.trim() || null,
  startedAt: new Date().toISOString(),
  digestsOn: Boolean(process.env.ANTHROPIC_API_KEY),
  backupStatusPath: backupStatus || (existsSync(DEFAULT_BACKUP_STATUS) ? DEFAULT_BACKUP_STATUS : null),
  secureCookies: secureCookiesFor(publicUrl),
  publicOrigin: publicUrl ?? null,
  dailyBudgetUsd,
  ...(posthogOn ? { pageview } : {}),
};

const client = { bundle: loadClientBundle(process.env.CLIENT_BUNDLE_PATH?.trim() || '/app/client/hub.mjs') };

const server = createServer(createHandler({ db, mcp: handleMcp(db), web, client, serverSummaries: Boolean(process.env.ANTHROPIC_API_KEY), ...(publicUrl ? { oauth: { publicUrl } } : {}) }));
logger.info(publicUrl ? 'oauth on' : 'oauth off, no PUBLIC_URL', publicUrl ? { public_url: publicUrl } : {});
logger.info('client bundle', { on: client.bundle !== null });
logger.info('dashboard on', { secure_cookies: web.secureCookies, backup_status: web.backupStatusPath ?? 'none' });

const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
let worker: { stop: () => Promise<void> } | null = null;

if (process.env.ANTHROPIC_API_KEY) {
  const effort = (process.env.DIGEST_EFFORT ?? 'low') as Effort;
  if (!EFFORTS.includes(effort)) throw new Error(`DIGEST_EFFORT must be one of: ${EFFORTS.join(', ')}`);
  const maxInputTokens = Number(process.env.DIGEST_MAX_INPUT_TOKENS ?? DEFAULT_MAX_INPUT_TOKENS);
  if (!Number.isInteger(maxInputTokens) || maxInputTokens < 1000) throw new Error('DIGEST_MAX_INPUT_TOKENS must be a whole number of at least 1000');
  if (maxInputTokens > 80000) {
    logger.warn('DIGEST_MAX_INPUT_TOKENS is high: with 2 characters per token, a full prompt can pass 100K tokens, which some models bill at a higher rate', { max_input_tokens: maxInputTokens });
  }
  const model = process.env.DIGEST_MODEL ?? DEFAULT_MODEL;
  worker = startWorker({ db, llm: new AnthropicLlm({ model, effort, onUsage: (u) => recordUsage(db, u, new Date().toISOString()) }), maxInputTokens, ...(dailyBudgetUsd === null ? {} : { dailyBudgetMicroUsd: Math.round(dailyBudgetUsd * 1_000_000) }) });
  logger.info('digests on', { model, effort });
} else {
  logger.info('fallback summaries off, no ANTHROPIC_API_KEY. Computers with Claude Code write their own summaries.');
}

server.listen(port, () => logger.info('listening', { port, database: path }));

const stop = (): void => {
  server.closeAllConnections();
  server.close(async () => {
    // In parallel: the PostHog flush (at most 3 s) must not eat into the digest's time to finish.
    await Promise.all([pageview.shutdown?.(), worker?.stop()]); // lets a digest that is mid-call finish and be saved
    db.close();
    process.exit(0);
  });
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
