import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db.js';
import { createGrant, createConnectCode, listGrants } from '../src/oauth/store.js';
import { AuthLimiter } from '../src/ratelimit.js';
import { createToken, listTokens } from '../src/tokens.js';
import { createWebSession, listWebSessions } from '../src/web/session.js';
import type { WebConfig } from '../src/web/routes.js';
import { startServer } from './helpers.js';

const START = new Date('2026-10-20T12:00:00.000Z');
const HOUR = 3_600_000;
const HUB = 'https://hub.test';
const ago = (ms: number): string => new Date(START.getTime() - ms).toISOString();

let db: Db;
let url: string;
let close: () => Promise<void>;
let clock: Date;
let cookie: string;

const web = (over: Partial<WebConfig> = {}): WebConfig => ({
  imageTag: null,
  startedAt: ago(HOUR),
  digestsOn: false,
  backupStatusPath: null,
  secureCookies: false,
  // On by default so every action test also exercises the Origin check; Node's fetch sends no Origin.
  publicOrigin: HUB,
  ...over,
});

const get = (path: string, c: string | null = cookie): Promise<Response> =>
  fetch(url + path, { redirect: 'manual', headers: c === null ? {} : { Cookie: c } });

const post = (
  path: string,
  fields: Record<string, string>,
  opts: { cookie?: string | null; headers?: Record<string, string> } = {},
): Promise<Response> =>
  fetch(url + path, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(opts.cookie === null ? {} : { Cookie: opts.cookie ?? cookie }),
      ...(opts.headers ?? {}),
    },
    body: new URLSearchParams(fields),
  });

/** The current session's anti-forgery value, which every form on the page carries. */
const csrfOf = (): string => listWebSessions(db).find((r) => r.revokedAt === null)!.csrf;

async function page(path: string): Promise<string> {
  const res = await get(path);
  expect(res.status).toBe(200);
  return res.text();
}

/** The first step of a disconnect: the confirmation page, which revokes nothing. */
const ask = (kind: string, id: string | number): Promise<Response> =>
  post('/sign-ins/disconnect', { csrf: csrfOf(), kind, id: String(id) });

/** The second step: the same fields plus `confirm`, which revokes. */
const confirm = (kind: string, id: string | number): Promise<Response> =>
  post('/sign-ins/disconnect', { csrf: csrfOf(), kind, id: String(id), confirm: 'yes' });

beforeEach(async () => {
  db = openDb(':memory:');
  clock = START;
  const s = await startServer({ db, now: () => clock, limiter: new AuthLimiter(() => clock.getTime()), web: web() });
  url = s.url;
  close = s.close;
  const { code } = createConnectCode(db, clock.toISOString());
  const login = await post('/login', { code }, { cookie: null });
  expect(login.status).toBe(302);
  cookie = login.headers.getSetCookie()[0]!.split(';')[0]!;
});

afterEach(async () => {
  await close();
});

describe('issuing codes', () => {
  const CODE = /[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}/;
  const codes = () =>
    db.prepare('SELECT purpose FROM connect_codes ORDER BY rowid').all() as { purpose: string }[];

  it('shows both buttons with the csrf field', async () => {
    const html = await page('/sign-ins');
    expect(html).toContain('action="/sign-ins/code"');
    expect(html).toContain(`name="csrf" value="${csrfOf()}"`);
    expect(html).toContain('name="purpose" value="device">Add a computer<');
    expect(html).toContain('name="purpose" value="signin">New sign-in code<');
  });

  it('issues a device code with the install line', async () => {
    const before = codes().length;
    const res = await post('/sign-ins/code', { csrf: csrfOf(), purpose: 'device' });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(new RegExp(`>${CODE.source}<`));
    expect(html).toContain('curl -fsSL https://hub.test/install | sh');
    expect(html).toContain('hub login');
    expect(html).toContain('Valid for 10 minutes, for one use.');
    expect(codes().slice(before)).toEqual([{ purpose: 'device' }]);
  });

  it('issues a sign-in code that works on /login', async () => {
    const res = await post('/sign-ins/code', { csrf: csrfOf(), purpose: 'signin' });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Enter it where claude.ai or another browser asks for a sign-in code.');
    expect(html).not.toContain('curl -fsSL');
    const code = html.match(CODE)![0];
    expect((await post('/login', { code }, { cookie: null })).status).toBe(302);
  });

  it('omits the curl line when no public URL is set', async () => {
    await close();
    const s = await startServer({ db, now: () => clock, limiter: new AuthLimiter(() => clock.getTime()), web: web({ publicOrigin: null }) });
    url = s.url;
    close = s.close;
    const html = await (await post('/sign-ins/code', { csrf: csrfOf(), purpose: 'device' })).text();
    expect(html).not.toContain('curl -fsSL');
    expect(html).toContain('hub login --url');
  });

  it('refuses a missing csrf, a foreign Origin and an unknown purpose, storing nothing', async () => {
    const before = codes().length;
    expect((await post('/sign-ins/code', { purpose: 'device' })).status).toBe(403);
    expect((await post('/sign-ins/code', { csrf: csrfOf(), purpose: 'device' }, { headers: { Origin: 'https://evil.test' } })).status).toBe(403);
    expect((await post('/sign-ins/code', { csrf: csrfOf(), purpose: 'admin' })).status).toBe(400);
    expect(codes().length).toBe(before);
  });
});

describe('the Sign-ins page', () => {
  it('lists Claude apps with their client name and permissions', async () => {
    createGrant(db, { clientId: 'c-1', clientName: 'Claude', scopes: ['hub.read', 'hub.save'] }, ago(3 * HOUR));
    const html = await page('/sign-ins');
    expect(html).toContain('Claude apps');
    expect(html).toContain('Claude');
    expect(html).toContain('read');
    expect(html).toContain('save notes');
    expect(html).toContain(`<time datetime="${ago(3 * HOUR)}"`);
  });

  it('lists tokens with their label, kind, created and last-used times', async () => {
    createToken(db, 'collector', 'ingest', ago(4 * HOUR));
    createToken(db, 'laptop', 'read', ago(2 * HOUR));
    db.prepare('UPDATE tokens SET last_used_at = ? WHERE label = ?').run(ago(HOUR), 'laptop');
    const html = await page('/sign-ins');
    expect(html).toContain('Tokens');
    expect(html).toContain('collector');
    expect(html).toContain('upload');
    expect(html).toContain('laptop');
    expect(html).toContain(`<time datetime="${ago(4 * HOUR)}"`);
    expect(html).toContain(`<time datetime="${ago(HOUR)}"`);
    expect(html).toContain('Never');
  });

  it('lists browsers and marks only the current one', async () => {
    createWebSession(db, ago(5 * HOUR));
    const html = await page('/sign-ins');
    expect(html).toContain('Browsers');
    expect(html.match(/this browser/g)).toHaveLength(1);
    expect(html).toContain(`<time datetime="${ago(5 * HOUR)}"`);
  });

  it('gives every active entry a Disconnect button and shows revoked ones greyed with no button', async () => {
    const grant = createGrant(db, { clientId: 'c-1', clientName: 'Claude', scopes: ['hub.read'] }, ago(3 * HOUR));
    createToken(db, 'collector', 'ingest', ago(4 * HOUR));
    const html = await page('/sign-ins');
    // Three active entries: the grant, the token and this browser.
    expect(html).not.toContain('name="confirm"');
    expect(html.match(/>Disconnect</g)).toHaveLength(3);
    expect(html).toContain('name="kind" value="grant"');
    expect(html).toContain('name="kind" value="token"');
    expect(html).toContain('name="kind" value="browser"');
    expect(html).toContain(`name="id" value="${grant}"`);

    expect((await confirm('grant', grant)).status).toBe(302);
    const after = await page('/sign-ins');
    expect(after.match(/>Disconnect</g)).toHaveLength(2);
    expect(after).toContain('class="revoked"');
    expect(after).toContain(`<time datetime="${START.toISOString()}"`);
  });

  it('shows no token hash, cookie hash or anti-forgery value of another session', async () => {
    createToken(db, 'collector', 'ingest', ago(4 * HOUR));
    const other = createWebSession(db, ago(5 * HOUR));
    const rows = listWebSessions(db);
    const hashes = [
      ...rows.map((r) => r.hash),
      (db.prepare('SELECT hash FROM tokens').get() as { hash: string }).hash,
    ];
    const html = await page('/sign-ins');
    for (const hash of hashes) {
      expect(hash).toHaveLength(64);
      expect(html).not.toContain(hash);
    }
    expect(html).not.toContain(other.cookie);
    expect(html).not.toContain(other.csrf);
    expect(html).not.toContain(cookie.slice('hub_session='.length));
    // The current session's own form field is the one anti-forgery value a page carries.
    expect(html).toContain(`value="${csrfOf()}"`);
  });

  it('escapes stored labels and client names, and renders every time as a <time> element', async () => {
    createGrant(db, { clientId: 'c-1', clientName: '<script>alert(1)</script>', scopes: ['hub.read'] }, ago(3 * HOUR));
    createToken(db, '<img onerror="x">', 'read', ago(2 * HOUR));
    const html = await page('/sign-ins');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img onerror=');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img onerror=&quot;x&quot;&gt;');
    // No inline style or script survives the Content-Security-Policy.
    expect(html).not.toMatch(/ style="/);
  });

  it('needs a session, like every other page', async () => {
    const res = await get('/sign-ins', null);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });
});

describe('the Disconnect confirmation', () => {
  it('names the consequence for an upload token and revokes nothing yet', async () => {
    const { id } = createToken(db, 'collector', 'ingest', ago(4 * HOUR));
    const res = await ask('token', id);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`Your PC's hub sync will stop working until you create a new upload token on the server.`);
    expect(html).toContain('name="confirm" value="yes"');
    expect(html).toContain('name="kind" value="token"');
    expect(html).toContain(`name="id" value="${id}"`);
    expect(html).toContain(`value="${csrfOf()}"`);
    expect(html).toContain('href="/sign-ins"');
    expect(html).toContain('Cancel');
    expect(listTokens(db)[0]!.revoked_at).toBe(null);
  });

  it('names the consequence for a read token', async () => {
    const { id } = createToken(db, 'laptop', 'read', ago(2 * HOUR));
    const html = await (await ask('token', id)).text();
    expect(html).toContain('Assistants using this token (for example Claude Code) will lose access to the hub.');
    expect(html).not.toContain('hub sync will stop working');
  });

  it('names the client for a Claude app, escaped', async () => {
    const id = createGrant(db, { clientId: 'c-1', clientName: 'Claude & Co', scopes: ['hub.read'] }, ago(3 * HOUR));
    const html = await (await ask('grant', id)).text();
    expect(html).toContain('Claude &amp; Co will need to sign in again.');
    expect(listGrants(db)[0]!.revokedAt).toBe(null);
  });

  it('says the current browser is signed out, and names another browser differently', async () => {
    const mine = listWebSessions(db)[0]!.id;
    createWebSession(db, ago(5 * HOUR));
    const other = listWebSessions(db).find((r) => r.id !== mine)!.id;
    expect(await (await ask('browser', mine)).text()).toContain('This signs this browser out.');
    const theirs = await (await ask('browser', other)).text();
    expect(theirs).toContain('That browser will be signed out.');
    expect(theirs).not.toContain('This signs this browser out.');
    expect(listWebSessions(db).every((r) => r.revokedAt === null)).toBe(true);
  });

  it('reads the kind and scope from the server, never from the form', async () => {
    const { id } = createToken(db, 'collector', 'ingest', ago(4 * HOUR));
    // A hostile form claiming the token is a harmless read token still gets the upload warning.
    const html = await (
      await post('/sign-ins/disconnect', { csrf: csrfOf(), kind: 'token', id: String(id), scope: 'read' })
    ).text();
    expect(html).toContain(`Your PC's hub sync will stop working`);
  });
});

describe('a confirmed Disconnect', () => {
  it('revokes a Claude app and returns to the Sign-ins page', async () => {
    const id = createGrant(db, { clientId: 'c-1', clientName: 'Claude', scopes: ['hub.read'] }, ago(3 * HOUR));
    const res = await confirm('grant', id);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/sign-ins');
    expect(listGrants(db)[0]!.revokedAt).toBe(clock.toISOString());
  });

  it('revokes a token and returns to the Sign-ins page', async () => {
    const { id, token } = createToken(db, 'collector', 'ingest', ago(4 * HOUR));
    expect(token.length).toBeGreaterThan(10);
    const res = await confirm('token', id);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/sign-ins');
    expect(listTokens(db)[0]!.revoked_at).toBe(clock.toISOString());
  });

  it('revokes another browser and leaves this one signed in', async () => {
    const mine = listWebSessions(db)[0]!.id;
    createWebSession(db, ago(5 * HOUR));
    const other = listWebSessions(db).find((r) => r.id !== mine)!.id;
    const res = await confirm('browser', other);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/sign-ins');
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(listWebSessions(db).find((r) => r.id === other)!.revokedAt).toBe(clock.toISOString());
    expect((await get('/sign-ins')).status).toBe(200);
  });

  it('signs this browser out, clears the cookie and lands on /login', async () => {
    const mine = listWebSessions(db)[0]!.id;
    const res = await confirm('browser', mine);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
    const set = res.headers.getSetCookie()[0]!;
    expect(set).toMatch(/^hub_session=;/);
    expect(set).toContain('Max-Age=0');
    expect(listWebSessions(db)[0]!.revokedAt).toBe(clock.toISOString());
    // The old cookie is dead, both for pages and for actions.
    const again = await get('/sign-ins');
    expect(again.status).toBe(302);
    expect(again.headers.get('location')).toBe('/login');
    expect((await post('/logout', {})).status).toBe(403);
  });
});

describe('a Disconnect that cannot be carried out', () => {
  it('answers a plain page for an unknown, already revoked or non-numeric id, and revokes nothing', async () => {
    const { id } = createToken(db, 'collector', 'ingest', ago(4 * HOUR));
    expect((await confirm('token', id)).status).toBe(302);
    const revokedAt = listTokens(db)[0]!.revoked_at;
    clock = new Date(START.getTime() + HOUR);

    for (const [kind, bad] of [
      ['token', String(id)],
      ['token', '9999'],
      ['grant', '1'],
      ['browser', '9999'],
      ['token', 'abc'],
      ['token', ''],
      ['token', '1; DROP TABLE tokens'],
      ['token', '-1'],
      ['token', '1e3'],
      // All digits, but past a safe integer: it must still be a page, never a bind parameter.
      ['token', '99999999999999999999'],
      ['nonsense', '1'],
    ] as const) {
      for (const res of [await ask(kind, bad), await confirm(kind, bad)]) {
        expect(res.status).toBe(404);
        expect(res.headers.get('content-type')).toContain('text/html');
        const html = await res.text();
        expect(html).toContain('Nothing');
        expect(html).toContain('href="/sign-ins"');
      }
    }
    // Nothing moved: the revoked time is still the first one, and this browser still works.
    expect(listTokens(db)[0]!.revoked_at).toBe(revokedAt);
    expect(listWebSessions(db)[0]!.revokedAt).toBe(null);
    expect((await get('/sign-ins')).status).toBe(200);
  });
});

describe('Disconnect across sites', () => {
  it('answers 403 and revokes nothing without the csrf field', async () => {
    const { id } = createToken(db, 'collector', 'ingest', ago(4 * HOUR));
    const res = await post('/sign-ins/disconnect', { kind: 'token', id: String(id), confirm: 'yes' });
    expect(res.status).toBe(403);
    expect(listTokens(db)[0]!.revoked_at).toBe(null);
  });

  it('answers 403 and revokes nothing for a wrong csrf field', async () => {
    const { id } = createToken(db, 'collector', 'ingest', ago(4 * HOUR));
    const res = await post('/sign-ins/disconnect', { csrf: 'x'.repeat(43), kind: 'token', id: String(id), confirm: 'yes' });
    expect(res.status).toBe(403);
    expect(listTokens(db)[0]!.revoked_at).toBe(null);
  });

  it('answers 403 and revokes nothing when the Origin is not this hub', async () => {
    const { id } = createToken(db, 'collector', 'ingest', ago(4 * HOUR));
    const foreign = await post(
      '/sign-ins/disconnect',
      { csrf: csrfOf(), kind: 'token', id: String(id), confirm: 'yes' },
      { headers: { Origin: 'https://evil.example' } },
    );
    expect(foreign.status).toBe(403);
    expect(listTokens(db)[0]!.revoked_at).toBe(null);
    // The same submission from the hub's own origin goes through.
    const own = await post(
      '/sign-ins/disconnect',
      { csrf: csrfOf(), kind: 'token', id: String(id), confirm: 'yes' },
      { headers: { Origin: HUB } },
    );
    expect(own.status).toBe(302);
    expect(listTokens(db)[0]!.revoked_at).toBe(clock.toISOString());
  });

  it('answers 403 and revokes nothing without a session', async () => {
    const { id } = createToken(db, 'collector', 'ingest', ago(4 * HOUR));
    const res = await post('/sign-ins/disconnect', { kind: 'token', id: String(id), confirm: 'yes' }, { cookie: null });
    expect(res.status).toBe(403);
    expect(listTokens(db)[0]!.revoked_at).toBe(null);
  });
});
