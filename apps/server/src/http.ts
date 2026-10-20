import type { IncomingMessage, ServerResponse } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { stripSecrets, type HashedSession } from '@context-hub/core';
import type { Db } from './db.js';
import { AuthLimiter } from './ratelimit.js';
import { deleteProject, deleteSession, status, upsertSession } from './store.js';
import { resourceUrl, type OAuthConfig } from './oauth/config.js';
import { handleOAuth } from './oauth/routes.js';
import { createConnectCode, touchGrant } from './oauth/store.js';
import { checkCredential, type Scope } from './tokens.js';
import { HttpError, parseSession } from './validate.js';

export const MAX_BODY = 20 * 1024 * 1024;
/** How long an unread request body is discarded before the connection is cut. */
const DRAIN_MS = 10_000;

export interface AppDeps {
  db: Db;
  now?: () => Date;
  limiter?: AuthLimiter;
  log?: (line: string) => void;
  /** When set, /mcp 401s carry a WWW-Authenticate challenge and OAuth access tokens are accepted there. */
  oauth?: OAuthConfig;
  /** Handles POST /mcp once the caller is authorised. Wired in main.ts. */
  mcp?: (req: IncomingMessage, res: ServerResponse, body: unknown) => Promise<void>;
}

export function send(res: ServerResponse, statusCode: number, body: unknown): void {
  if (res.headersSent) return;
  const text = JSON.stringify(body);
  const headers: Record<string, string | number> = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) };
  // If we answer before reading the whole request body, the unread bytes would be
  // parsed as the next request on a kept-alive connection and stall the client.
  // So discard what is still arriving. Closing the socket instead would reset it
  // before the client has read this answer. The timer bounds how long a client
  // can keep sending into the void.
  const req = res.req;
  if (!req.complete) {
    const cut = setTimeout(() => req.destroy(), DRAIN_MS);
    cut.unref();
    req.once('end', () => clearTimeout(cut));
    req.once('close', () => clearTimeout(cut));
    req.resume();
  }
  res.writeHead(statusCode, headers);
  res.end(req.method === 'HEAD' ? undefined : text);
}

function decodePart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, 'The address contains an invalid percent-encoding');
  }
}

function clientAddress(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
  return first || req.socket.remoteAddress || 'unknown';
}

/** Reads the request body, refusing anything over the limit before or after decompression. */
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'The upload is larger than 20 MB');
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks);
  if (req.headers['content-encoding'] !== 'gzip') return raw;
  try {
    return gunzipSync(raw, { maxOutputLength: MAX_BODY });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ERR_BUFFER_TOO_LARGE') throw new HttpError(413, 'The upload is larger than 20 MB once decompressed');
    throw new HttpError(400, 'The body is marked gzip but could not be decompressed');
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const body = await readBody(req);
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new HttpError(400, 'The body is not valid JSON');
  }
}

/** Runs the secret stripper again, in case the collector that sent this is out of date. */
function stripAgain(session: HashedSession): { session: HashedSession; redactions: number } {
  let redactions = 0;
  const clean = (s: string): string => {
    const out = stripSecrets(s);
    for (const n of Object.values(out.counts)) redactions += n;
    return out.text;
  };
  const messages = session.messages.map((m) =>
    m.kind === 'text' ? { ...m, text: clean(m.text) } : { ...m, tool_input: clean(m.tool_input), tool_result: clean(m.tool_result) },
  );
  return { session: { ...session, title: clean(session.title), messages }, redactions };
}

export function createHandler(deps: AppDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const limiter = deps.limiter ?? new AuthLimiter();
  const log = deps.log ?? ((line: string) => console.log(line));

  const challenge = (res: ServerResponse, presented: boolean): void => {
    if (!deps.oauth) return;
    const metadata = `resource_metadata="${resourceUrl(deps.oauth).slice(0, -'/mcp'.length)}/.well-known/oauth-protected-resource"`;
    res.setHeader('WWW-Authenticate', presented ? `Bearer error="invalid_token", ${metadata}` : `Bearer ${metadata}`);
  };

  /** `mcp` marks the one route that also accepts OAuth access tokens (with hub.read). */
  const authorise = (req: IncomingMessage, res: ServerResponse, allowed: Scope[], mcp = false): void => {
    const unauthorised = (presented: boolean): never => {
      if (mcp) challenge(res, presented);
      throw new HttpError(401, 'A valid token is required');
    };
    const header = req.headers.authorization ?? '';
    if (header === '') return unauthorised(false);
    const token = /^Bearer\s+(\S+)$/i.exec(header)?.[1] ?? '';
    const found = checkCredential(db, token, now().toISOString());
    if (found !== null && found !== 'dead') {
      if (found.kind === 'bearer') {
        if (!allowed.includes(found.scope)) throw new HttpError(403, `This token's scope is ${found.scope}; this needs ${allowed.join(' or ')}`);
      } else {
        if (!mcp || !found.scopes.includes('hub.read')) throw new HttpError(403, 'This token cannot be used here; it needs hub.read on /mcp');
        touchGrant(db, found.grantId, now().toISOString());
      }
      return;
    }
    const address = clientAddress(req);
    if (limiter.isBlocked(address)) throw new HttpError(429, 'Too many failed attempts. Try again in 15 minutes.');
    if (found === null) limiter.recordFailure(address);
    return unauthorised(true);
  };

  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? 'GET';
    const path = new URL(req.url ?? '/', 'http://local').pathname;

    if (deps.oauth && (path.startsWith('/.well-known/') || path.startsWith('/oauth/'))) {
      const handled = await handleOAuth(req, res, path, method, {
        db,
        cfg: deps.oauth,
        limiter,
        address: clientAddress(req),
        readBody: () => readBody(req),
      });
      if (handled) return;
    }

    if (path === '/healthz' && (method === 'GET' || method === 'HEAD')) return send(res, 200, { status: 'ok' });

    // Someone opening the address in a browser should see that the service is
    // up, not an error. Says nothing about what is stored.
    if (path === '/' && (method === 'GET' || method === 'HEAD')) {
      return send(res, 200, {
        name: 'context-hub',
        status: 'ok',
        message: 'This service is running. It has no web page: it is used through the hub command and by AI assistants over MCP.',
      });
    }

    if (path === '/api/status' && method === 'GET') {
      authorise(req, res, ['ingest', 'read']);
      return send(res, 200, status(db));
    }

    if (path === '/api/connect-code' && method === 'POST') {
      authorise(req, res, ['ingest']);
      const { code, expiresAt } = createConnectCode(db, now().toISOString());
      res.setHeader('Cache-Control', 'no-store');
      return send(res, 200, { code, expires_at: expiresAt });
    }

    const sessionPath = /^\/api\/sessions\/([^/]+)\/(.+)$/.exec(path);
    if (sessionPath && (method === 'PUT' || method === 'DELETE')) {
      authorise(req, res, ['ingest']);
      const source = decodePart(sessionPath[1]!);
      const id = decodePart(sessionPath[2]!);
      if (method === 'DELETE') return send(res, 200, { deleted: deleteSession(db, source, id) });
      const parsed = parseSession(await readJson(req), source, id);
      const { session, redactions } = stripAgain(parsed);
      if (redactions > 0) log(`${source}:${id}: server stripped ${redactions} secret(s); the collector may be out of date`);
      const { changed } = upsertSession(db, session, now().toISOString());
      return send(res, 200, { stored: true, changed, server_redactions: redactions });
    }

    const projectPath = /^\/api\/projects\/(.+)$/.exec(path);
    if (projectPath && method === 'DELETE') {
      authorise(req, res, ['ingest']);
      return send(res, 200, { deleted: deleteProject(db, decodePart(projectPath[1]!)) });
    }

    if (path === '/mcp') {
      authorise(req, res, ['read'], true);
      if (method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return send(res, 405, { error: 'Only POST is supported on /mcp' });
      }
      if (!deps.mcp) return send(res, 501, { error: 'The lookup tools are not enabled on this server' });
      return deps.mcp(req, res, await readJson(req));
    }

    send(res, 404, { error: 'Not found' });
  };

  return (req, res) => {
    route(req, res).catch((e: unknown) => {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      log(`error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      send(res, 500, { error: 'Internal error' });
    });
  };
}
