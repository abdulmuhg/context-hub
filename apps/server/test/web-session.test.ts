import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db.js';
import { AuthLimiter } from '../src/ratelimit.js';
import { createConnectCode } from '../src/oauth/store.js';
import { createToken } from '../src/tokens.js';
import { upsertSession } from '../src/store.js';
import { listWebSessions, revokeWebSession } from '../src/web/session.js';
import { secureCookiesFor, type WebConfig } from '../src/web/routes.js';
import { makeSession, startServer } from './helpers.js';

const START = new Date('2026-10-20T00:00:00.000Z');
const KEY = 'github.com/me/alpha';
const HUB = 'https://hub.test';

let db: Db;
let url: string;
let close: () => Promise<void>;
let clock: Date;
let limiter: AuthLimiter;

const web = (over: Partial<WebConfig> = {}): WebConfig => ({
  imageTag: null,
  startedAt: START.toISOString(),
  digestsOn: false,
  backupStatusPath: null,
  secureCookies: false,
  // On by default so every action test also exercises the Origin check; Node's fetch sends no Origin.
  publicOrigin: HUB,
  ...over,
});

async function start(cfg: Partial<WebConfig> = {}): Promise<void> {
  db = openDb(':memory:');
  clock = START;
  limiter = new AuthLimiter(() => clock.getTime());
  const s = await startServer({ db, now: () => clock, limiter, web: web(cfg) });
  url = s.url;
  close = s.close;
}

/** Stores one session so the database has a project name that must never leak. */
const storeProject = (): void => void upsertSession(db, makeSession(), START.toISOString());

const get = (path: string, cookie?: string) =>
  fetch(url + path, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });

const post = (path: string, fields: Record<string, string>, opts: { cookie?: string; headers?: Record<string, string> } = {}) =>
  fetch(url + path, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(opts.cookie ? { Cookie: opts.cookie } : {}),
      ...(opts.headers ?? {}),
    },
    body: new URLSearchParams(fields),
  });

/** Signs in with a fresh connect code and returns the cookie header to send back. */
async function signIn(): Promise<string> {
  const { code } = createConnectCode(db, clock.toISOString());
  const res = await post('/login', { code });
  expect(res.status).toBe(302);
  const set = res.headers.getSetCookie()[0]!;
  return set.split(';')[0]!;
}

beforeEach(async () => {
  await start();
});

afterEach(async () => {
  await close();
});

describe('signed-out access', () => {
  it('sends the bare address to /login with an empty body', async () => {
    storeProject();
    const res = await get('/');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
    expect(res.headers.get('content-length')).toBe('0');
    expect(await res.text()).toBe('');
  });

  it('sends a project deep link to /login without naming the project', async () => {
    storeProject();
    const res = await get(`/projects/${encodeURIComponent(KEY)}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
    expect(res.headers.get('location')).not.toContain('alpha');
    expect(await res.text()).toBe('');
  });

  it('names no project in any body a signed-out browser can reach', async () => {
    storeProject();
    const bodies = [await (await get('/login')).text(), await (await post('/logout', {})).text()];
    for (const body of bodies) {
      // Guards against the claim passing only because the body is empty.
      expect(body.length).toBeGreaterThan(100);
      expect(body).not.toMatch(/alpha|github|sqlite|token|\d{2,}/i);
    }
  });

  it('answers HEAD on a page the same way', async () => {
    const res = await get('/');
    expect(res.status).toBe(302);
    expect((await fetch(url + '/', { method: 'HEAD', redirect: 'manual' })).status).toBe(302);
  });

  it('refuses any POST other than /login with 403', async () => {
    const res = await post('/logout', {});
    expect(res.status).toBe(403);
    const other = await post('/sign-ins/disconnect', { kind: 'web', id: '1' });
    expect(other.status).toBe(403);
  });

  it('leaves /healthz alone', async () => {
    const res = await get('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});

describe('GET /login', () => {
  it('shows the code field and the hint, and no project names', async () => {
    storeProject();
    const res = await get('/login');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('name="code"');
    expect(html).toContain('Run hub connect on your PC to get one.');
    expect(html).not.toContain('alpha');
  });

  it('carries the full set of security headers', async () => {
    const res = await get('/login');
    const csp = res.headers.get('content-security-policy');
    expect(csp).toBe(
      "default-src 'none'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; " +
        "script-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('POST /login', () => {
  it('a right code sets the session cookie and lands on the overview', async () => {
    const { code } = createConnectCode(db, clock.toISOString());
    const res = await post('/login', { code });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    const set = res.headers.getSetCookie()[0]!;
    expect(set).toMatch(/^hub_session=/);
    expect(set).toContain('HttpOnly');
    expect(set).toContain('SameSite=Strict');
    expect(set).toContain('Path=/');
    expect(set).toContain('Max-Age=2592000');
    expect(set).not.toContain('Secure');
    const cookie = set.split(';')[0]!;
    const signedIn = await get('/', cookie);
    expect(signedIn.status).toBe(200);
    expect(signedIn.headers.get('content-type')).toContain('text/html');
  });

  it('marks the cookie Secure when the hub is on https', async () => {
    await close();
    await start({ secureCookies: true });
    const { code } = createConnectCode(db, clock.toISOString());
    const res = await post('/login', { code });
    expect(res.headers.getSetCookie()[0]!).toContain('Secure');
  });

  it('stores the cookie value only as a hash', async () => {
    const cookie = await signIn();
    const value = cookie.slice('hub_session='.length);
    const rows = listWebSessions(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.hash).not.toContain(value);
    expect(rows[0]!.hash).toHaveLength(64);
  });

  it('re-shows the form for a wrong code and blocks the address after ten', async () => {
    const wrong = await post('/login', { code: 'AAAA-AAAA' });
    expect(wrong.status).toBe(200);
    expect(await wrong.text()).toContain('That code is wrong or has expired.');
    expect(wrong.headers.getSetCookie()).toEqual([]);
    for (let i = 0; i < 9; i++) expect((await post('/login', { code: 'AAAA-AAAA' })).status).toBe(200);
    const blocked = await post('/login', { code: 'AAAA-AAAA' });
    expect(blocked.status).toBe(429);
    expect(await blocked.text()).toContain('Too many wrong codes. Try again in 15 minutes.');
  });

  it('refuses a code that was already used', async () => {
    const { code } = createConnectCode(db, clock.toISOString());
    expect((await post('/login', { code })).status).toBe(302);
    expect((await post('/login', { code })).status).toBe(200);
  });

  it('refuses a sign-in posted from another site, and those tries never block the address', async () => {
    const foreign = { headers: { Origin: 'https://evil.test' } };
    for (let i = 0; i < 11; i++) expect((await post('/login', { code: 'AAAA-AAAA' }, foreign)).status).toBe(403);
    expect(limiter.isBlocked('127.0.0.1')).toBe(false);
    const { code } = createConnectCode(db, clock.toISOString());
    expect((await post('/login', { code }, foreign)).status).toBe(403);
    // The code was refused before being consumed, so it still works from the hub itself.
    expect((await post('/login', { code })).status).toBe(302);
  });
});

describe('secureCookiesFor', () => {
  it('follows the scheme, so every loopback address drops Secure', () => {
    expect(secureCookiesFor('https://hub.test')).toBe(true);
    expect(secureCookiesFor('http://localhost:3000')).toBe(false);
    expect(secureCookiesFor('http://127.0.0.1:3000')).toBe(false);
    expect(secureCookiesFor('http://[::1]:3000')).toBe(false);
    expect(secureCookiesFor(undefined)).toBe(false);
  });
});

describe('an existing session', () => {
  it('stops working after 30 days', async () => {
    const cookie = await signIn();
    expect((await get('/', cookie)).status).toBe(200);
    clock = new Date(START.getTime() + 31 * 86_400_000);
    const res = await get('/', cookie);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });

  it('stops working once revoked', async () => {
    const cookie = await signIn();
    expect(revokeWebSession(db, listWebSessions(db)[0]!.id, clock.toISOString())).toBe(true);
    const res = await get('/', cookie);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });

  it('records when it was last used', async () => {
    const cookie = await signIn();
    clock = new Date(START.getTime() + 3_600_000);
    await get('/', cookie);
    expect(listWebSessions(db)[0]!.lastUsedAt).toBe(clock.toISOString());
  });

  it('is not accepted on /mcp or /api/*', async () => {
    const cookie = await signIn();
    const mcp = await fetch(url + '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: '{}',
    });
    expect(mcp.status).toBe(401);
    expect((await get('/api/status', cookie)).status).toBe(401);
  });

  it('is not even looked up by a POST to a path the dashboard does not own', async () => {
    const cookie = await signIn();
    const before = listWebSessions(db)[0]!.lastUsedAt;
    clock = new Date(START.getTime() + 60_000);
    for (const path of ['/api/nope', '/oauth/nope', '/nope']) {
      const res = await fetch(url + path, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie } });
      expect(res.status).toBe(404);
      expect(await res.json()).toHaveProperty('error');
    }
    expect(listWebSessions(db)[0]!.lastUsedAt).toBe(before);
  });

  it('does not let a bearer token open a page', async () => {
    const read = createToken(db, 'assistant', 'read', clock.toISOString()).token;
    const res = await fetch(url + '/', { redirect: 'manual', headers: { Authorization: `Bearer ${read}` } });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });
});

describe('POST /logout', () => {
  it('clears the cookie and revokes the session when the csrf field matches', async () => {
    const cookie = await signIn();
    const { id, csrf } = listWebSessions(db)[0]!;
    const res = await post('/logout', { csrf }, { cookie });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
    const set = res.headers.getSetCookie()[0]!;
    expect(set).toMatch(/^hub_session=;/);
    expect(set).toContain('Max-Age=0');
    expect(listWebSessions(db).find((r) => r.id === id)!.revokedAt).toBe(clock.toISOString());
    expect((await get('/', cookie)).status).toBe(302);
  });

  it('answers 403 and changes nothing without the csrf field', async () => {
    const cookie = await signIn();
    const res = await post('/logout', {}, { cookie });
    expect(res.status).toBe(403);
    expect(listWebSessions(db)[0]!.revokedAt).toBe(null);
    expect((await get('/', cookie)).status).toBe(200);
  });

  it('answers 403 for a wrong csrf field', async () => {
    const cookie = await signIn();
    const res = await post('/logout', { csrf: 'x'.repeat(43) }, { cookie });
    expect(res.status).toBe(403);
    expect(listWebSessions(db)[0]!.revokedAt).toBe(null);
  });

  it('answers 403 when the Origin is not this hub', async () => {
    const cookie = await signIn();
    const { csrf } = listWebSessions(db)[0]!;
    const foreign = await post('/logout', { csrf }, { cookie, headers: { Origin: 'https://evil.test' } });
    expect(foreign.status).toBe(403);
    expect(listWebSessions(db)[0]!.revokedAt).toBe(null);
    const own = await post('/logout', { csrf }, { cookie, headers: { Origin: HUB } });
    expect(own.status).toBe(302);
  });

  it('still checks the csrf field when no public origin is configured', async () => {
    await close();
    await start({ publicOrigin: null });
    const cookie = await signIn();
    expect((await post('/logout', {}, { cookie, headers: { Origin: 'https://evil.test' } })).status).toBe(403);
    const { csrf } = listWebSessions(db)[0]!;
    expect((await post('/logout', { csrf }, { cookie, headers: { Origin: 'https://evil.test' } })).status).toBe(302);
  });
});
