import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { PostHog } from 'posthog-node';
import { logger } from './logger.js';

export interface PageviewEvent {
  distinctId: string;
  event: '$pageview';
  properties: { app: 'context-hub'; $current_url: string; $pathname: string };
}

export interface PageviewOpts {
  /** The PostHog project key (phc_...). Without it nothing is ever sent. */
  key: string | undefined;
  host?: string;
  /** Replaces the PostHog client, for tests. */
  send?: (event: PageviewEvent) => void;
}

export type PageviewCapture = ((req: IncomingMessage, status: number, contentType: string, sessionId: number | null) => void) & {
  /** Flushes queued events; resolves even when PostHog is down. */
  shutdown?: () => Promise<void>;
};

/** Collapses dynamic segments so no project key leaves the server. */
function templatePath(path: string): string {
  return path.startsWith('/projects/') ? '/projects/:key' : path;
}

const DEFAULT_HOST = 'https://us.i.posthog.com';

/**
 * Server-side `$pageview` for each HTML page the web UI serves (GET, 200, text/html). Only the path is
 * sent, never the query string, and the visitor is a hash of the browser session id. Capture failures
 * only log a warning; they never reach the response.
 */
export function createPageviewCapture(opts: PageviewOpts): PageviewCapture {
  const key = opts.key?.trim();
  if (!key) return Object.assign(() => {}, {});

  let send = opts.send;
  let shutdown: (() => Promise<void>) | undefined;
  if (!send) {
    const client = new PostHog(key, { host: opts.host?.trim() || DEFAULT_HOST, flushAt: 20, flushInterval: 10_000 });
    client.on('error', (err: unknown) => logger.warn('posthog error', { error: String(err) }));
    shutdown = () => client.shutdown(3000).catch((err: unknown) => logger.warn('posthog shutdown failed', { error: String(err) }));
    send = (e) => client.capture({ distinctId: e.distinctId, event: e.event, properties: e.properties });
  }
  const emit = send;

  const capture: PageviewCapture = (req, status, contentType, sessionId) => {
    if (req.method !== 'GET' || status !== 200 || !contentType.toLowerCase().startsWith('text/html')) return;
    try {
      const path = templatePath((req.url ?? '/').split(/[?#]/, 1)[0] || '/');
      const distinctId = sessionId === null ? 'anonymous' : createHash('sha256').update(`context-hub:${sessionId}`).digest('hex');
      emit({ distinctId, event: '$pageview', properties: { app: 'context-hub', $current_url: path, $pathname: path } });
    } catch (err) {
      logger.warn('posthog capture failed', { error: String(err) });
    }
  };
  if (shutdown) capture.shutdown = shutdown;
  return capture;
}
