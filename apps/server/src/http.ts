import type { IncomingMessage, ServerResponse } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { stripSecrets, type DigestBody, type HashedSession, type UploadDigest } from '@context-hub/core';
import { forgetActivityForProject, forgetActivityForSession, logActivitySafe, recordSyncRun } from './activity.js';
import { installScript } from './client-dist.js';
import type { Db } from './db.js';
import { cleanDeviceName, exchangeDeviceCode } from './devices.js';
import { AuthLimiter } from './ratelimit.js';
import { deleteProjectState, okDigestsForProject, pageInputs, projectsNeedingPage, saveComputerOutcome, savePageIfVersion } from './digest-store.js';
import { deleteProject, deleteSession, getStoredSession, listProjectDigests, status, storeUpload } from './store.js';
import { resourceUrl, type OAuthConfig } from './oauth/config.js';
import { handleOAuth } from './oauth/routes.js';
import { createConnectCode, touchGrant } from './oauth/store.js';
import type { McpCaller } from './mcp.js';
import { actorFor, checkCredential, type Credential, type Scope } from './tokens.js';
import { HttpError, parseSession, parseUploadDigest } from './validate.js';
import { handleWeb, type WebConfig } from './web/routes.js';

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
  mcp?: (req: IncomingMessage, res: ServerResponse, body: unknown, caller: McpCaller) => Promise<void>;
  /** When set, the browser dashboard is served. Wired in main.ts. */
  web?: WebConfig;
  /** The collector's single-file bundle served at /hub.mjs. Wired in main.ts. */
  client?: { bundle: string | null };
  /** True when the server has a model key and writes summaries for computers that cannot. Reported by /api/status. */
  serverSummaries?: boolean;
}

/**
 * If we answer before reading the whole request body, the unread bytes would be
 * parsed as the next request on a kept-alive connection and stall the client.
 * So discard what is still arriving. Closing the socket instead would reset it
 * before the client has read this answer. The timer bounds how long a client
 * can keep sending into the void.
 */
export function drainBody(res: ServerResponse): void {
  const req = res.req;
  if (req.complete) return;
  const cut = setTimeout(() => req.destroy(), DRAIN_MS);
  cut.unref();
  req.once('end', () => clearTimeout(cut));
  req.once('close', () => clearTimeout(cut));
  req.resume();
}

export function send(res: ServerResponse, statusCode: number, body: unknown): void {
  if (res.headersSent) return;
  const text = JSON.stringify(body);
  const headers: Record<string, string | number> = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) };
  const req = res.req;
  drainBody(res);
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

/** The same safety net for the summary a computer sends: every text in it is stripped again. */
function stripDigestAgain(digest: UploadDigest): { digest: UploadDigest; redactions: number } {
  let redactions = 0;
  const clean = (s: string): string => {
    const out = stripSecrets(s);
    for (const n of Object.values(out.counts)) redactions += n;
    return out.text;
  };
  if ('body' in digest) {
    const b = digest.body;
    const body: DigestBody = {
      goal: clean(b.goal),
      done: b.done.map((d) => ({ ...d, text: clean(d.text) })),
      decisions: b.decisions.map((d) => ({ ...d, what: clean(d.what), why: clean(d.why) })),
      open_items: b.open_items.map((d) => ({ ...d, text: clean(d.text) })),
      key_refs: b.key_refs.map(clean),
    };
    return { digest: { ...digest, body }, redactions };
  }
  if ('refused' in digest) return { digest: { ...digest, refused: clean(digest.refused) }, redactions };
  if ('failed' in digest) return { digest: { ...digest, failed: clean(digest.failed) }, redactions };
  return { digest, redactions };
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

  /** `mcp` marks the one route that also accepts OAuth access tokens (with hub.read). Returns the credential it accepted. */
  const authorise = (req: IncomingMessage, res: ServerResponse, allowed: Scope[], mcp = false): Credential => {
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
      return found;
    }
    // A stale token this hub issued is not a guess: answer 401 with the challenge so the
    // client refreshes, even from a blocked address. On Anthropic's shared addresses a
    // stranger's guesses must not stall the owner's connector.
    if (found === 'dead') return unauthorised(true);
    const address = clientAddress(req);
    if (limiter.isBlocked(address)) throw new HttpError(429, 'Too many failed attempts. Try again in 15 minutes.');
    limiter.recordFailure(address);
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

    if ((path === '/install' || path === '/hub.mjs') && (method === 'GET' || method === 'HEAD')) {
      const publicUrl = deps.oauth?.publicUrl ?? deps.web?.publicOrigin ?? null;
      const text = publicUrl === null ? null : path === '/install' ? installScript(publicUrl) : (deps.client?.bundle ?? null);
      if (text === null) return send(res, 404, { error: 'Not found' });
      const type = path === '/install' ? 'text/x-shellscript; charset=utf-8' : 'text/javascript; charset=utf-8';
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': Buffer.byteLength(text),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      return void res.end(method === 'HEAD' ? undefined : text);
    }

    if (path === '/api/status' && method === 'GET') {
      authorise(req, res, ['ingest', 'read']);
      const owed = (db.prepare('SELECT COUNT(*) AS n FROM digests WHERE summary_to_follow = 1').get() as { n: number }).n;
      return send(res, 200, { ...status(db), server_summaries: deps.serverSummaries ?? false, pages_needed: projectsNeedingPage(db), summaries_owed: owed });
    }

    if (path === '/api/connect-code' && method === 'POST') {
      authorise(req, res, ['ingest']);
      const { code, expiresAt } = createConnectCode(db, now().toISOString());
      res.setHeader('Cache-Control', 'no-store');
      return send(res, 200, { code, expires_at: expiresAt });
    }

    if (path === '/api/devices' && method === 'POST') {
      // The one unauthenticated route that makes a credential: checked against the limiter before the code is read.
      const address = clientAddress(req);
      if (limiter.isBlocked(address)) throw new HttpError(429, 'Too many failed attempts. Try again in 15 minutes.');
      const body = await readJson(req);
      const r = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
      if (typeof r.code !== 'string') throw new HttpError(400, 'code must be a string');
      const made = exchangeDeviceCode(db, { code: r.code, name: cleanDeviceName(r.name) }, now().toISOString());
      if (made === null) {
        limiter.recordFailure(address);
        return send(res, 401, { error: 'That code is wrong or has expired.' });
      }
      res.setHeader('Cache-Control', 'no-store');
      return send(res, 200, made);
    }

    if (path === '/api/sync-runs' && method === 'POST') {
      const credential = authorise(req, res, ['ingest']);
      const body = await readJson(req);
      const r = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
      const count = (name: string): number => {
        const v = r[name];
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new HttpError(400, `${name} must be a non-negative whole number`);
        return v;
      };
      const finishedAt = r.finished_at;
      if (typeof finishedAt !== 'string' || Number.isNaN(Date.parse(finishedAt))) throw new HttpError(400, 'finished_at must be an ISO time');
      const run = { finishedAt: new Date(finishedAt).toISOString(), uploaded: count('uploaded'), unchanged: count('unchanged'), errors: count('errors') };
      // Only a bearer credential reaches here (ingest scope), so it always carries a token id.
      recordSyncRun(db, { tokenId: (credential as Extract<Credential, { kind: 'bearer' }>).id, ...run }, now().toISOString());
      res.writeHead(204);
      return void res.end();
    }

    // Ids and keys are URL-encoded, so these never contain a raw slash. They come before the catch-all below.
    const digestPath = /^\/api\/sessions\/([^/]+)\/([^/]+)\/digest$/.exec(path);
    if (digestPath && method === 'PUT') {
      const actor = actorFor(authorise(req, res, ['ingest']));
      const source = decodePart(digestPath[1]!);
      const id = decodePart(digestPath[2]!);
      const body = await readJson(req);
      const o = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
      if (typeof o.hash !== 'string') throw new HttpError(400, 'hash must be a string');
      const parsedDigest = parseUploadDigest(o.digest);
      if (parsedDigest === undefined) throw new HttpError(400, 'Invalid digest: it is required');
      const { digest, redactions } = stripDigestAgain(parsedDigest);
      if (redactions > 0) log(`${source}:${id}: server stripped ${redactions} secret(s) from its summary; the collector may be out of date`);
      const row = db
        .prepare("SELECT id FROM sessions WHERE source = ? AND source_session_id = ? AND parent IS NULL AND source <> 'doc'")
        .get(source, id) as { id: number } | undefined;
      if (!row) throw new HttpError(404, 'No such session');
      if (!saveComputerOutcome(db, row.id, o.hash, digest, actor, now().toISOString())) {
        return send(res, 409, { error: 'The session changed since this summary was written' });
      }
      res.writeHead(204);
      return void res.end();
    }

    const storedPath = /^\/api\/sessions\/([^/]+)\/([^/]+)$/.exec(path);
    if (storedPath && method === 'GET') {
      authorise(req, res, ['ingest']);
      const session = getStoredSession(db, decodePart(storedPath[1]!), decodePart(storedPath[2]!));
      if (!session) throw new HttpError(404, 'No such session');
      return send(res, 200, { session });
    }

    const sessionPath = /^\/api\/sessions\/([^/]+)\/(.+)$/.exec(path);
    if (sessionPath && (method === 'PUT' || method === 'DELETE')) {
      const actor = actorFor(authorise(req, res, ['ingest']));
      const source = decodePart(sessionPath[1]!);
      const id = decodePart(sessionPath[2]!);
      if (method === 'DELETE') {
        const ref = `${source}:${id}`;
        const owner = db
          .prepare('SELECT p.key AS key FROM sessions s JOIN projects p ON p.id = s.project_id WHERE s.source = ? AND s.source_session_id = ?')
          .get(source, id) as { key: string } | undefined;
        const deleted = deleteSession(db, source, id);
        try {
          forgetActivityForSession(db, ref);
        } catch (e) {
          log(`activity log failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        logActivitySafe(
          db,
          { direction: 'in', action: 'delete', projectKey: owner?.key ?? null, sessionRef: null, actor, detail: null },
          now().toISOString(),
          log,
        );
        return send(res, 200, { deleted });
      }
      const parsedBody = await readJson(req);
      const parsed = parseSession(parsedBody, source, id);
      const uploaded = parseUploadDigest((parsedBody as Record<string, unknown>).digest);
      const { session, redactions } = stripAgain(parsed);
      if (redactions > 0) log(`${source}:${id}: server stripped ${redactions} secret(s); the collector may be out of date`);
      const strippedDigest = uploaded === undefined ? undefined : stripDigestAgain(uploaded);
      if (strippedDigest && strippedDigest.redactions > 0) {
        log(`${source}:${id}: server stripped ${strippedDigest.redactions} secret(s) from its summary; the collector may be out of date`);
      }
      const digest = strippedDigest?.digest;
      const { changed } = storeUpload(db, session, digest, actor, now().toISOString());
      if (changed) {
        logActivitySafe(
          db,
          {
            direction: 'in',
            action: 'upload',
            projectKey: session.project_key,
            sessionRef: `${source}:${id}`,
            actor,
            detail: session.title.slice(0, 100),
          },
          now().toISOString(),
          log,
        );
      }
      return send(res, 200, { stored: true, changed, server_redactions: redactions });
    }

    const projectDigests = /^\/api\/projects\/([^/]+)\/digests$/.exec(path);
    if (projectDigests && method === 'GET') {
      authorise(req, res, ['ingest']);
      const sessions = listProjectDigests(db, decodePart(projectDigests[1]!));
      if (!sessions) throw new HttpError(404, 'No such project');
      return send(res, 200, { sessions });
    }

    const projectPage = /^\/api\/projects\/([^/]+)\/(page-inputs|page)$/.exec(path);
    if (projectPage && (method === 'GET' || method === 'PUT' || method === 'DELETE')) {
      const actor = actorFor(authorise(req, res, ['ingest']));
      const row = db.prepare('SELECT id FROM projects WHERE key = ?').get(decodePart(projectPage[1]!)) as { id: number } | undefined;
      if (!row) throw new HttpError(404, 'No such project');
      if (projectPage[2] === 'page-inputs' && method === 'GET') return send(res, 200, pageInputs(db, row.id));
      if (projectPage[2] === 'page' && method === 'DELETE') {
        // A page with digests behind it is rebuilt, not removed.
        if (okDigestsForProject(db, row.id).length > 0) return send(res, 409, { error: 'The project still has summaries' });
        deleteProjectState(db, row.id);
        res.writeHead(204);
        return void res.end();
      }
      if (projectPage[2] === 'page' && method === 'PUT') {
        const body = await readJson(req);
        const o = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
        const text = (field: string): string => {
          const v = o[field];
          if (typeof v !== 'string' || v === '') throw new HttpError(400, `Invalid page: ${field} must be a non-empty string`);
          return v;
        };
        const base = o.base_version;
        if (base !== null && !(typeof base === 'number' && Number.isInteger(base) && base >= 0)) throw new HttpError(400, 'Invalid page: base_version must be a whole number or null');
        const through = o.through;
        if (typeof through !== 'number' || !Number.isInteger(through) || through < 0) throw new HttpError(400, 'Invalid page: through must be a whole number');
        if (typeof o.full_rebuild !== 'boolean') throw new HttpError(400, 'Invalid page: full_rebuild must be true or false');
        const saved = savePageIfVersion(
          db,
          row.id,
          { summary: text('summary'), body: text('body'), model: text('model') },
          { baseVersion: base as number | null, through, fullRebuild: o.full_rebuild, writtenBy: actor, now: now().toISOString() },
        );
        if (!saved.ok) return send(res, 409, { error: 'The page changed; fetch it again' });
        return send(res, 200, { version: saved.version });
      }
    }

    const projectPath = /^\/api\/projects\/(.+)$/.exec(path);
    if (projectPath && method === 'DELETE') {
      const actor = actorFor(authorise(req, res, ['ingest']));
      const key = decodePart(projectPath[1]!);
      const deleted = deleteProject(db, key);
      try {
        forgetActivityForProject(db, key);
      } catch (e) {
        log(`activity log failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      logActivitySafe(db, { direction: 'in', action: 'delete', projectKey: null, sessionRef: null, actor, detail: null }, now().toISOString(), log);
      return send(res, 200, { deleted });
    }

    // "/mcp/" too: claude.ai keeps the URL as typed, and a 404 there gives no sign-in challenge.
    if (path === '/mcp' || path === '/mcp/') {
      const credential = authorise(req, res, ['read'], true);
      if (method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return send(res, 405, { error: 'Only POST is supported on /mcp' });
      }
      if (!deps.mcp) return send(res, 501, { error: 'The lookup tools are not enabled on this server' });
      // Saving is an OAuth grant's privilege: a bearer token (read) never gets the tool.
      const canSave = credential.kind === 'oauth' && credential.scopes.includes('hub.save');
      return deps.mcp(req, res, await readJson(req), { canSave, actor: actorFor(credential) });
    }

    // The dashboard comes last, so a browser session is never even looked at on /mcp or /api/*.
    if (deps.web) {
      const handled = await handleWeb(req, res, path, method, {
        db,
        cfg: deps.web,
        limiter,
        address: clientAddress(req),
        now: () => now().toISOString(),
        readBody: () => readBody(req),
      });
      if (handled) return;
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
