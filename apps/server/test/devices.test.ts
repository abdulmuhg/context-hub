import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db.js';
import { cleanDeviceName } from '../src/devices.js';
import { createConnectCode } from '../src/oauth/store.js';
import { AuthLimiter } from '../src/ratelimit.js';
import { createToken, listTokens } from '../src/tokens.js';
import { createWebSession } from '../src/web/session.js';
import { makeSession, startServer } from './helpers.js';

const NOW = new Date('2026-10-20T12:00:00.000Z');

let db: Db;
let url: string;
let close: () => Promise<void>;

const exchange = (body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(url + '/api/devices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const deviceCode = (): string => createConnectCode(db, NOW.toISOString(), 'device').code;

beforeEach(async () => {
  db = openDb(':memory:');
  const s = await startServer({
    db,
    now: () => NOW,
    limiter: new AuthLimiter(() => NOW.getTime()),
    web: { imageTag: null, startedAt: NOW.toISOString(), digestsOn: false, backupStatusPath: null, secureCookies: false, publicOrigin: null, dailyBudgetUsd: null },
  });
  url = s.url;
  close = s.close;
});

afterEach(async () => {
  await close();
});

describe('POST /api/devices', () => {
  it('swaps a device code for an upload token that can upload', async () => {
    const res = await exchange({ code: deviceCode(), name: 'abdul-macbook' });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const { token, label } = (await res.json()) as { token: string; label: string };
    expect(token).toMatch(/^chub_/);
    expect(label).toBe('abdul-macbook');
    expect(listTokens(db).find((t) => t.label === 'abdul-macbook')?.scope).toBe('ingest');

    const s = makeSession();
    const put = await fetch(`${url}/api/sessions/${s.source}/${s.source_session_id}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(s),
    });
    expect(put.status).toBe(200);
  });

  it('refuses the same code twice', async () => {
    const code = deviceCode();
    expect((await exchange({ code, name: 'a' })).status).toBe(200);
    const again = await exchange({ code, name: 'a' });
    expect(again.status).toBe(401);
    expect(await again.json()).toEqual({ error: 'That code is wrong or has expired.' });
  });

  it('refuses a sign-in code and leaves it usable for signing in', async () => {
    const { code } = createConnectCode(db, NOW.toISOString());
    expect((await exchange({ code, name: 'a' })).status).toBe(401);
    const login = await fetch(url + '/login', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code }),
    });
    expect(login.status).toBe(302);
  });

  it('blocks an address after ten wrong codes but not a different address', async () => {
    const from = { 'X-Forwarded-For': '203.0.113.9' };
    for (let i = 0; i < 10; i++) expect((await exchange({ code: 'AAAA-AAAA', name: 'a' }, from)).status).toBe(401);
    const code = deviceCode();
    expect((await exchange({ code, name: 'a' }, from)).status).toBe(429);
    expect((await exchange({ code, name: 'a' }, { 'X-Forwarded-For': '203.0.113.10' })).status).toBe(200);
  });

  it('answers 400 for a body that is not JSON or has no code', async () => {
    expect((await exchange('not json')).status).toBe(400);
    expect((await exchange({ name: 'a' })).status).toBe(400);
  });

  it('turns a hostile name into a safe label that the Sign-ins page shows escaped', async () => {
    const res = await exchange({ code: deviceCode(), name: '<img src=x onerror=alert(1)>' });
    const { label } = (await res.json()) as { label: string };
    expect(label).toBe('img srcx onerroralert1');

    const { cookie } = createWebSession(db, NOW.toISOString());
    const html = await (await fetch(url + '/sign-ins', { headers: { Cookie: `hub_session=${cookie}` } })).text();
    expect(html).toContain('img srcx onerroralert1');
    expect(html).not.toContain('<img src=x');
  });

  it('stores a hostile name as a safe label even if the page is given a raw one', async () => {
    createToken(db, '<b>x</b>', 'ingest', NOW.toISOString());
    const { cookie } = createWebSession(db, NOW.toISOString());
    const html = await (await fetch(url + '/sign-ins', { headers: { Cookie: `hub_session=${cookie}` } })).text();
    expect(html).not.toContain('<b>x</b>');
  });
});

describe('cleanDeviceName', () => {
  it('keeps letters, digits, space, dot, underscore and hyphen', () => {
    expect(cleanDeviceName('  Abdul’s Mac_1.local-x ')).toBe('Abduls Mac_1.local-x');
  });
  it('cuts to 40 characters', () => {
    expect(cleanDeviceName('a'.repeat(500))).toHaveLength(40);
  });
  it('falls back to computer for symbols only or a non-string', () => {
    expect(cleanDeviceName('!!!')).toBe('computer');
    expect(cleanDeviceName(42)).toBe('computer');
    expect(cleanDeviceName(undefined)).toBe('computer');
  });
  it('has no angle brackets, equals signs or parentheses in the hostile case', () => {
    expect(cleanDeviceName('<img src=x onerror=alert(1)>')).not.toMatch(/[<>=()]/);
  });
});
