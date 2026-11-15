import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db.js';
import { createConnectCode } from '../src/oauth/store.js';
import { CSP } from '../src/web/html.js';
import { parseLanding, type WebConfig } from '../src/web/routes.js';
import { countWaitlist, listWaitlist, WAITLIST_MAX } from '../src/waitlist.js';
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

describe('the waitlist form', () => {
  let wUrl: string;
  let wDb: Db;
  let offDb: Db;
  let wOffUrl: string;
  let originUrl: string;
  let originCfg: WebConfig;
  const closeAll: Array<() => Promise<void>> = [];

  beforeEach(async () => {
    wDb = openDb(':memory:');
    offDb = openDb(':memory:');
    const a = await startServer({ db: wDb, now: () => NOW, web: config(true) });
    const b = await startServer({ db: offDb, now: () => NOW, web: config(false) });
    originCfg = config(true);
    const c = await startServer({ db: openDb(':memory:'), now: () => NOW, web: originCfg });
    originCfg.publicOrigin = c.url; // this server is started with publicOrigin set to its own address
    wUrl = a.url;
    wOffUrl = b.url;
    originUrl = c.url;
    closeAll.push(a.close, b.close, c.close);
  });

  afterEach(async () => {
    await Promise.all(closeAll.splice(0).map((c) => c()));
  });

  const post = (base: string, body: string, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(`${base}/waitlist`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body,
    });

  it('stores a new address, lowercased, and thanks the visitor', async () => {
    const res = await post(wUrl, 'email=%20Ada%40Example.com%20');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('You are on the list');
    expect(html).not.toContain('ada@example.com');
    expect(listWaitlist(wDb).map((r) => r.email)).toEqual(['ada@example.com']);
  });

  it('answers a repeat exactly like a first time', async () => {
    const first = await (await post(wUrl, 'email=ada%40example.com')).text();
    const again = await post(wUrl, 'email=ada%40example.com');
    expect(again.status).toBe(200);
    expect(await again.text()).toBe(first);
    expect(countWaitlist(wDb)).toBe(1);
  });

  it.each(['', 'email=', 'email=nope', `email=${'a'.repeat(300)}%40x.co`, 'other=1'])('refuses %j with the form again', async (body) => {
    const res = await post(wUrl, body);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('That does not look like an email address.');
    expect(countWaitlist(wDb)).toBe(0);
  });

  it('refuses a waitlist body over the limit and keeps answering', async () => {
    const res = await post(wUrl, `email=${'a'.repeat(10_000)}%40example.com`);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('That does not look like an email address.');
    expect(countWaitlist(wDb)).toBe(0);
    expect((await post(wUrl, 'email=ada%40example.com')).status).toBe(200);
  });

  it('refuses a gzip-marked waitlist body', async () => {
    const res = await post(wUrl, 'email=ada%40example.com', { 'content-encoding': 'gzip' });
    expect(res.status).toBe(400);
    expect(countWaitlist(wDb)).toBe(0);
  });

  it('is a 404 that stores nothing when LANDING is off', async () => {
    expect((await post(wOffUrl, 'email=ada%40example.com')).status).toBe(404);
    expect(countWaitlist(offDb)).toBe(0);
  });

  it('refuses a post from another origin', async () => {
    expect((await post(originUrl, 'email=ada%40example.com', { origin: 'https://evil.example' })).status).toBe(403);
  });

  it('blocks the eleventh post in five minutes, without blocking sign-in', async () => {
    for (let i = 0; i < 10; i++) await post(wUrl, `email=u${i}%40example.com`);
    const res = await post(wUrl, 'email=u10%40example.com');
    expect(res.status).toBe(429);
    expect(await res.text()).toContain('Too many tries from this address.');
    expect(countWaitlist(wDb)).toBe(10);
    const login = await fetch(`${wUrl}/login`, { method: 'POST', body: 'code=WRONG', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(login.status).toBe(200);
    expect(await login.text()).toContain('wrong or has expired');
  });

  it('says the waitlist is full with a 503 and stores nothing more', async () => {
    const insert = wDb.prepare('INSERT INTO waitlist(email, created_at) VALUES (?, ?)');
    wDb.transaction(() => {
      for (let i = 0; i < WAITLIST_MAX; i++) insert.run(`u${i}@example.com`, NOW.toISOString());
    })();
    const res = await post(wUrl, 'email=late%40example.com');
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('The waitlist is full right now.');
    expect(countWaitlist(wDb)).toBe(WAITLIST_MAX);
  });
});
