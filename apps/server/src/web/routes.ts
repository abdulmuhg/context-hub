import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from '../db.js';
import type { AuthLimiter } from '../ratelimit.js';
import { consumeConnectCode } from '../oauth/store.js';
import { isAsset, serveAsset } from './assets.js';
import { forbiddenPage, redirectTo, sendDocument, signInPage } from './html.js';
import { overviewPage } from './pages.js';
import { checkWebSession, clearedCookie, createWebSession, parseCookies, revokeWebSession, sameCsrf, sessionCookie } from './session.js';

export interface WebConfig {
  imageTag: string | null;
  startedAt: string;
  digestsOn: boolean;
  backupStatusPath: string | null;
  secureCookies: boolean;
  /** The hub's own origin, used to refuse cross-site actions. Null when PUBLIC_URL is unset (tests, local runs). */
  publicOrigin: string | null;
}

export interface WebCtx {
  db: Db;
  cfg: WebConfig;
  limiter: AuthLimiter;
  address: string;
  now: () => string;
  readBody: () => Promise<Buffer>;
}

/** The browser session behind the current request. */
export interface WebSession {
  id: number;
  csrf: string;
}

/** Pages that need a session. `/projects/<key>` keeps its percent-encoded key, so it is matched by prefix. */
const PAGES = new Set(['/', '/activity', '/projects', '/sign-ins']);
const isPage = (path: string): boolean => PAGES.has(path) || path.startsWith('/projects/');

/** The POST forms the dashboard owns. `/sign-ins/disconnect` is Task 8's; it is listed so no POST path is ambiguous. */
const ACTIONS = new Set(['/logout', '/sign-ins/disconnect']);

/**
 * Whether the browser cookie is marked `Secure`. Keyed off the scheme, not the host: a
 * `Secure` cookie is dropped on any plain-http origin, and `PUBLIC_URL` also allows
 * `http://127.0.0.1` and `http://[::1]` besides `http://localhost`.
 */
export function secureCookiesFor(publicUrl: string | undefined): boolean {
  return publicUrl?.startsWith('https://') ?? false;
}

function currentSession(req: IncomingMessage, ctx: WebCtx): WebSession | null {
  const value = parseCookies(req.headers.cookie)['hub_session'] ?? '';
  return checkWebSession(ctx.db, value, ctx.now());
}

/**
 * Whether the browser's `Origin` is this hub's. An absent header is allowed (a plain form post
 * from an older browser); a present one that differs is a cross-site submission. Skipped when no
 * public origin is configured, where `SameSite=Strict` and the anti-forgery field still apply.
 */
export function originAllowed(req: IncomingMessage, cfg: WebConfig): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin === '' || cfg.publicOrigin === null) return true;
  return origin === cfg.publicOrigin;
}

/**
 * The two checks every action carries, beyond `SameSite=Strict`: the per-session anti-forgery
 * field, and the browser's `Origin` when it sends one. Shared so every POST form is checked alike.
 */
export function actionAllowed(req: IncomingMessage, form: URLSearchParams, session: WebSession, cfg: WebConfig): boolean {
  return originAllowed(req, cfg) && sameCsrf(form.get('csrf') ?? '', session.csrf);
}

async function login(req: IncomingMessage, res: ServerResponse, ctx: WebCtx): Promise<void> {
  // Refused before the code is read, so a hostile page cannot spend the owner's tries and
  // get their address blocked by submitting guesses from the owner's browser.
  if (!originAllowed(req, ctx.cfg)) return forbiddenPage(res);
  // The address is checked before the code, so a blocked address cannot keep guessing.
  if (ctx.limiter.isBlocked(ctx.address)) return signInPage(res, { wrongCode: false, blocked: true });
  const form = new URLSearchParams((await ctx.readBody()).toString('utf8'));
  const now = ctx.now();
  if (!consumeConnectCode(ctx.db, form.get('code') ?? '', now)) {
    ctx.limiter.recordFailure(ctx.address);
    return signInPage(res, { wrongCode: true, blocked: false });
  }
  const { cookie } = createWebSession(ctx.db, now);
  res.setHeader('Set-Cookie', sessionCookie(cookie, ctx.cfg.secureCookies));
  redirectTo(res, '/');
}

function logout(res: ServerResponse, session: WebSession, ctx: WebCtx): void {
  revokeWebSession(ctx.db, session.id, ctx.now());
  res.setHeader('Set-Cookie', clearedCookie(ctx.cfg.secureCookies));
  redirectTo(res, '/login');
}

/**
 * Handles the dashboard: pages, sign-in and the POST actions. Returns true if the request was
 * answered. A signed-out page answers 302 to /login and a signed-out action answers 403, both
 * without naming anything that is stored.
 */
export async function handleWeb(req: IncomingMessage, res: ServerResponse, path: string, method: string, ctx: WebCtx): Promise<boolean> {
  if (method === 'POST') {
    // Sign-in is the one action a browser without a session may post. Everything else is refused.
    if (path === '/login') {
      await login(req, res, ctx);
      return true;
    }
    // A POST to a path the dashboard does not own is left to the 404, so the cookie is never
    // even looked up on, say, an unknown /api/ path.
    if (!ACTIONS.has(path) && !isPage(path)) return false;
    const session = currentSession(req, ctx);
    if (session === null) {
      forbiddenPage(res);
      return true;
    }
    const form = new URLSearchParams((await ctx.readBody()).toString('utf8'));
    if (!actionAllowed(req, form, session, ctx.cfg)) {
      forbiddenPage(res);
      return true;
    }
    if (path === '/logout') {
      logout(res, session, ctx);
      return true;
    }
    return false;
  }

  if (method !== 'GET' && method !== 'HEAD') return false;

  // The sign-in page and the two assets are the only GETs that need no session.
  if (path === '/login') {
    signInPage(res, { wrongCode: false, blocked: false });
    return true;
  }
  if (isAsset(path)) {
    serveAsset(req, res, path);
    return true;
  }
  if (!isPage(path)) return false;

  const session = currentSession(req, ctx);
  if (session === null) {
    redirectTo(res, '/login');
    return true;
  }
  if (path === '/') {
    sendDocument(res, 200, overviewPage(ctx.db, ctx.cfg, ctx.now(), session.csrf));
    return true;
  }
  return false;
}
