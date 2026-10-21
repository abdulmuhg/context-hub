import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db.js';
import { AuthLimiter } from '../src/ratelimit.js';
import { createConnectCode } from '../src/oauth/store.js';
import { CSP, pageShell } from '../src/web/html.js';
import type { WebConfig } from '../src/web/routes.js';
import { startServer } from './helpers.js';

const START = new Date('2026-10-20T00:00:00.000Z');
let db: Db;
let url: string;
let close: () => Promise<void>;

const cfg: WebConfig = { imageTag: null, startedAt: START.toISOString(), digestsOn: false, backupStatusPath: null, secureCookies: false, publicOrigin: null, dailyBudgetUsd: null };

beforeEach(async () => {
  db = openDb(':memory:');
  const s = await startServer({ db, now: () => START, limiter: new AuthLimiter(() => START.getTime()), web: cfg });
  url = s.url;
  close = s.close;
});
afterEach(async () => close());

async function signedInHome(): Promise<Response> {
  const { code } = createConnectCode(db, START.toISOString());
  const login = await fetch(url + '/login', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code }),
  });
  const cookie = login.headers.getSetCookie()[0]!.split(';')[0]!;
  return fetch(url + '/', { headers: { Cookie: cookie } });
}

describe('page shell', () => {
  it('serves a signed-in page with the security headers and no inline script or style', async () => {
    const res = await signedInHome();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBe(CSP);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    // Asset links carry a letters-only fingerprint so a deploy never serves a cached old copy.
    expect(html).toMatch(/href="\/assets\/app\.css\?v=[a-p]+"/);
    expect(html).toMatch(/<script src="\/assets\/app\.js\?v=[a-p]+"><\/script>/);
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toMatch(/<script[^>]*>[^<]+<\/script>/);
    expect(html).not.toMatch(/\sstyle=/);
    expect(html).not.toMatch(/\son[a-z]+=/);
    for (const href of ['/', '/activity', '/projects', '/sign-ins']) expect(html).toContain(`href="${href}"`);
    expect(html).toMatch(/<form method="post" action="\/logout">\s*<input type="hidden" name="csrf" value="[^"]+">/);
  });

  it('marks only the active page in the sidebar', () => {
    const html = pageShell({ title: 'Activity', active: 'activity', csrf: 'c', body: '<p>x</p>' });
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(/<a href="\/activity"[^>]*aria-current="page"/);
    expect(html).toContain('<p>x</p>');
    expect(html).not.toMatch(/\sstyle=/);
  });

  it('escapes the title and csrf value', () => {
    const html = pageShell({ title: '<b>"', active: 'overview', csrf: '"><x>', body: '' });
    expect(html).not.toContain('<b>"');
    expect(html).not.toContain('"><x>');
  });

  it('styles the sign-in page', async () => {
    const res = await fetch(url + '/login');
    const html = await res.text();
    expect(html).toMatch(/href="\/assets\/app\.css\?v=[a-p]+"/);
    expect(html).not.toMatch(/\sstyle=/);
  });
});

describe('assets', () => {
  it('serves app.css with both themes and long-lived caching, without a session', async () => {
    const res = await fetch(url + '/assets/app.css');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/css/);
    expect(res.headers.get('cache-control')).toMatch(/max-age=\d{6,}/);
    expect(res.headers.get('cache-control')).not.toContain('no-store');
    expect(res.headers.get('content-security-policy')).toBe(CSP);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const css = await res.text();
    for (const c of ['#FAFAF9', '#151514', '#18181B', '#F5F5F3', '#FFFFFF', '#1C1C1A', '#E7E5E4', '#2E2E2B', '#78716C', '#A8A29E', '#15704A', '#2E9E6B', '#B42318', '#F04438']) {
      expect(css.toUpperCase()).toContain(c.toUpperCase());
    }
    expect(css).toContain('[data-theme="dark"]');
    expect(css).toContain('[data-theme="light"]');
    expect(css).toContain('prefers-color-scheme: dark');
    expect(css).toContain('https://fonts.googleapis.com/css2');
    expect(css).toContain('Inter');
    expect(css).toContain('JetBrains Mono');
    expect(css).not.toContain('Space Mono');
    expect(css).toContain('max-width: 767px');
  });

  it('serves app.js that guards localStorage and rewrites time elements', async () => {
    const res = await fetch(url + '/assets/app.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^(text|application)\/javascript/);
    expect(res.headers.get('cache-control')).toMatch(/max-age=\d{6,}/);
    const js = await res.text();
    expect(js).toContain("'hub-theme'");
    expect(js).toMatch(/try\s*\{[^}]*localStorage\.getItem/);
    expect(js).toMatch(/try\s*\{[^}]*localStorage\.setItem/);
    expect(js).toContain('time[datetime]');
  });

  it('answers HEAD and leaves other methods alone', async () => {
    const head = await fetch(url + '/assets/app.css', { method: 'HEAD' });
    expect(head.status).toBe(200);
    const post = await fetch(url + '/assets/app.css', { method: 'POST' });
    expect(post.status).toBe(404);
  });
});

describe('app icon', () => {
  const pngSize = (b: Buffer): [number, number] => [b.readUInt32BE(16), b.readUInt32BE(20)];

  it('serves the SVG icon, which follows the system theme, without a session', async () => {
    const res = await fetch(url + '/favicon.svg');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/svg+xml');
    const svg = await res.text();
    expect(svg).toContain('<svg');
    expect(svg).toContain('prefers-color-scheme: dark');
  });

  it('serves real PNGs at the classic and home-screen addresses', async () => {
    for (const [path, size] of [['/favicon.ico', 32], ['/apple-touch-icon.png', 180]] as const) {
      const res = await fetch(url + path);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      const body = Buffer.from(await res.arrayBuffer());
      expect(body.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      expect(pngSize(body)).toEqual([size, size]);
    }
  });

  it('links the icons from every page, including the sign-in page', async () => {
    const html = await (await fetch(url + '/login')).text();
    expect(html).toContain('<link rel="icon" href="/favicon.ico" type="image/png">');
    expect(html).toMatch(/<link rel="icon" href="\/favicon\.svg\?v=[a-p]+" type="image\/svg\+xml">/);
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png">');
  });
});
