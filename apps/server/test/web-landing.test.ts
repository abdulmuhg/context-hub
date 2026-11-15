import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db.js';
import { createConnectCode } from '../src/oauth/store.js';
import { CSP } from '../src/web/html.js';
import { parseLanding, type WebConfig } from '../src/web/routes.js';
import { startServer } from './helpers.js';

const NOW = new Date('2026-11-15T12:00:00.000Z');

let db: Db;
let url: string;
let offUrl: string;
let cookie: string;
const closers: Array<() => Promise<void>> = [];

const config = (landing: boolean): WebConfig => ({
  imageTag: null,
  startedAt: NOW.toISOString(),
  digestsOn: false,
  backupStatusPath: null,
  secureCookies: false,
  publicOrigin: null,
  dailyBudgetUsd: null,
  landing,
});

beforeEach(async () => {
  db = openDb(':memory:');
  const on = await startServer({ db, now: () => NOW, web: config(true) });
  const off = await startServer({ db: openDb(':memory:'), now: () => NOW, web: config(false) });
  url = on.url;
  offUrl = off.url;
  closers.push(on.close, off.close);
  const { code } = createConnectCode(db, NOW.toISOString());
  const login = await fetch(url + '/login', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code }),
  });
  cookie = login.headers.getSetCookie()[0]!.split(';')[0]!;
});

afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
});

describe('the landing page', () => {
  it('shows the landing page at / to a signed-out visitor when LANDING is on', async () => {
    const res = await fetch(`${url}/`, { redirect: 'manual' });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Your AI assistants forget. Your hub does not.');
    expect(html).toContain('docker compose up -d');
    expect(html).toContain('<form method="post" action="/waitlist"');
    expect(html).toContain('not open yet');
    expect(html).toContain('href="/login"');
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/);
    expect(html).not.toMatch(/\sstyle=|<style/);
    expect(res.headers.get('content-security-policy')).toBe(CSP);
  });

  it('still shows the Overview at / to a signed-in browser', async () => {
    const html = await (await fetch(`${url}/`, { headers: { cookie } })).text();
    expect(html).toContain('<h1>Overview</h1>');
  });

  it('redirects / to /login when LANDING is off', async () => {
    const res = await fetch(`${offUrl}/`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });

  it('serves the landing stylesheet', async () => {
    const href = /href="(\/assets\/landing\.css[^"]*)"/.exec(await (await fetch(`${url}/`)).text())![1]!;
    const res = await fetch(`${url}${href}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/css/);
  });

  it('the sign-in page links back to the landing page only when it is on', async () => {
    expect(await (await fetch(`${url}/login`)).text()).toContain('<a href="/">What is context-hub?</a>');
    const off = await (await fetch(`${offUrl}/login`)).text();
    expect(off).not.toContain('What is context-hub?');
    expect(off).toContain('hub connect');
  });

  it('parseLanding accepts on and off and refuses anything else', () => {
    expect(parseLanding(undefined)).toBe(false);
    expect(parseLanding('')).toBe(false);
    expect(parseLanding('off')).toBe(false);
    expect(parseLanding('on')).toBe(true);
    expect(() => parseLanding('yes')).toThrow(/LANDING must be on or off/);
  });
});
