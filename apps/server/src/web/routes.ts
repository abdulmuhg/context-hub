import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from '../db.js';
import type { AuthLimiter } from '../ratelimit.js';
import { consumeConnectCode } from '../oauth/store.js';
import { escapeHtml, forbiddenPage, redirectTo, sendPage, signInPage } from './html.js';
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

function currentSession(req: IncomingMessage, ctx: WebCtx): WebSession | null {
  const value = parseCookies(req.headers.cookie)['hub_session'] ?? '';
  return checkWebSession(ctx.db, value, ctx.now());
}

/**
 * The two checks every action carries, beyond `SameSite=Strict`: the per-session anti-forgery
 * field, and the browser's `Origin` when it sends one. Shared so every POST form is checked alike.
 */
export function actionAllowed(req: IncomingMessage, form: URLSearchParams, session: WebSession, cfg: WebConfig): boolean {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin !== '' && cfg.publicOrigin !== null && origin !== cfg.publicOrigin) return false;
  return sameCsrf(form.get('csrf') ?? '', session.csrf);
}

async function login(res: ServerResponse, ctx: WebCtx): Promise<void> {
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

/** Stands in for the Overview until Task 5 builds it. Shows no stored data. */
function placeholder(res: ServerResponse, session: WebSession): void {
  sendPage(
    res,
    200,
    'context-hub',
    `<main><h1>context-hub</h1><p>You are signed in.</p>
<form method="post" action="/logout"><input type="hidden" name="csrf" value="${escapeHtml(session.csrf)}"><button type="submit">Sign out</button></form></main>`,
  );
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
      await login(res, ctx);
      return true;
    }
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

  if (path === '/login') {
    signInPage(res, { wrongCode: false, blocked: false });
    return true;
  }
  if (!isPage(path)) return false;

  const session = currentSession(req, ctx);
  if (session === null) {
    redirectTo(res, '/login');
    return true;
  }
  if (path === '/') {
    placeholder(res, session);
    return true;
  }
  return false;
}
