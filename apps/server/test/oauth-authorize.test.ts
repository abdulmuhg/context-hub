import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OAuthConfig } from '../src/oauth/config.js';
import { openDb, type Db } from '../src/db.js';
import { createConnectCode } from '../src/oauth/store.js';
import { listGrants } from '../src/oauth/store.js';
import { startServer } from './helpers.js';

const CB = 'https://claude.ai/api/mcp/auth_callback';
const NOW = new Date().toISOString();

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

let db: Db;
let url: string;
async function start(extra: Partial<OAuthConfig> = {}): Promise<void> {
  db = openDb(':memory:');
  const s = await startServer({ db, oauth: { publicUrl: 'https://hub.test', ...extra } });
  close = s.close;
  url = s.url;
}

async function register(name = 'Claude', uris = [CB]): Promise<string> {
  const res = await fetch(url + '/oauth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: name, redirect_uris: uris }),
  });
  return (await res.json()).client_id;
}

const params = (clientId: string, over: Record<string, string> = {}): Record<string, string> => ({
  client_id: clientId,
  redirect_uri: CB,
  response_type: 'code',
  code_challenge: 'abc123challenge',
  code_challenge_method: 'S256',
  state: 'xyz',
  scope: 'hub.read offline_access',
  ...over,
});

const getPage = (p: Record<string, string>) => fetch(`${url}/oauth/authorize?${new URLSearchParams(p)}`, { redirect: 'manual' });
const postForm = (p: Record<string, string>, headers: Record<string, string> = {}) =>
  fetch(url + '/oauth/authorize', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(p),
  });

describe('GET/POST /oauth/authorize', () => {
  it('shows the page', async () => {
    await start();
    const id = await register('Claude Desktop');
    const res = await getPage(params(id));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const html = await res.text();
    expect(html).toContain('Claude Desktop');
    expect(html).toContain('claude.ai');
    expect(html).toContain('name="code"');
    expect(html).toMatch(/<input[^>]*name="save"[^>]*checked/);
    expect(html).toContain('Connect to context-hub');
  });

  it('escapes reflected values', async () => {
    await start();
    const id = await register('<script>alert(1)</script>');
    const html = await (await getPage(params(id, { state: '"><img src=x onerror=1>' }))).text();
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('"><img');
    expect(html).toContain('&quot;&gt;&lt;img');
  });

  it('sets a CSP that allows the redirect to Claude', async () => {
    await start();
    const id = await register();
    const csp = (await getPage(params(id))).headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self' https://claude.ai https://claude.com");
  });

  it('refuses near-miss redirects with an error page, not a redirect', async () => {
    await start();
    const id = await register();
    for (const bad of [
      'https://claude.ai/api/mcp/auth_callback/',
      'HTTPS://CLAUDE.AI/api/mcp/auth_callback',
      'https://claude.ai/api/mcp/auth_callback?x=1',
      'http://claude.ai/api/mcp/auth_callback',
    ]) {
      for (const res of [await getPage(params(id, { redirect_uri: bad })), await postForm({ ...params(id, { redirect_uri: bad }), code: 'AAAA-AAAA' })]) {
        expect(res.status).toBe(400);
        expect(res.headers.get('location')).toBeNull();
        expect(await res.text()).toContain("This sign-in request can't be used");
      }
    }
  });

  it('redirects protocol errors with state', async () => {
    await start();
    const id = await register();
    const p = params(id);
    delete (p as Record<string, string | undefined>).code_challenge;
    const res = await getPage(p);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${CB}?error=invalid_request&state=xyz`);
    const plain = await getPage(params(id, { code_challenge_method: 'plain' }));
    expect(plain.headers.get('location')).toBe(`${CB}?error=invalid_request&state=xyz`);
    expect((await getPage(params(id, { response_type: 'token' }))).headers.get('location')).toContain('error=unsupported_response_type');
    expect((await getPage(params(id, { resource: 'https://evil.test/mcp' }))).headers.get('location')).toContain('error=invalid_target');
    expect((await getPage(params(id, { resource: 'https://hub.test/mcp' }))).status).toBe(200);
  });

  it('a right code issues an auth code and redirects', async () => {
    await start();
    const id = await register();
    const { code } = createConnectCode(db, NOW);
    const res = await postForm({ ...params(id), code, save: 'on' });
    expect(res.status).toBe(302);
    const loc = res.headers.get('location')!;
    expect(loc).toMatch(/^https:\/\/claude\.ai\/api\/mcp\/auth_callback\?code=chub_ac_[A-Za-z0-9_-]+&state=xyz&iss=https%3A%2F%2Fhub\.test$/);
    expect(listGrants(db)[0]!.scopes).toEqual(['hub.read', 'hub.save', 'offline_access']);

    const second = createConnectCode(db, NOW).code;
    const res2 = await postForm({ ...params(id), code: second });
    expect(res2.status).toBe(302);
    expect(listGrants(db).map((g) => g.scopes.join(' '))).toContain('hub.read offline_access');
    const unticked = listGrants(db).find((g) => !g.scopes.includes('hub.save'));
    expect(unticked).toBeDefined();
  });

  it('a wrong or stale code re-shows the page', async () => {
    await start();
    const id = await register();
    const res = await postForm({ ...params(id), code: 'WRONG-CODE' });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('That code is wrong or has expired');
    expect(html).toContain('name="state" value="xyz"');
    expect(html).toContain('name="code_challenge" value="abc123challenge"');
    expect(html).toContain(`name="client_id" value="${id}"`);
    expect(listGrants(db)).toHaveLength(0);
  });

  it('wrong codes are rate-limited by the browser address', async () => {
    await start();
    const id = await register();
    const a = { 'X-Forwarded-For': '203.0.113.5' };
    for (let i = 0; i < 10; i++) expect((await postForm({ ...params(id), code: 'BAD' + i }, a)).status).toBe(200);
    const { code } = createConnectCode(db, NOW);
    expect((await postForm({ ...params(id), code }, a)).status).toBe(429);
    const other = await postForm({ ...params(id), code }, { 'X-Forwarded-For': '203.0.113.6' });
    expect(other.status).toBe(302);
  });

  it('a used connect code does not work twice', async () => {
    await start();
    const id = await register();
    const { code } = createConnectCode(db, NOW);
    expect((await postForm({ ...params(id), code })).status).toBe(302);
    expect((await postForm({ ...params(id), code })).status).toBe(200);
    expect(listGrants(db)).toHaveLength(1);
  });

  it('keeps the declined save choice on retry', async () => {
    await start();
    const id = await register();
    const wrong = await postForm({ ...params(id), code: 'WRONG-CODE' });
    expect(await wrong.text()).not.toMatch(/<input[^>]*name="save"[^>]*checked/);
    const { code } = createConnectCode(db, NOW);
    expect((await postForm({ ...params(id), code })).status).toBe(302);
    expect(listGrants(db)[0]!.scopes).not.toContain('hub.save');
  });

  it('checks the limiter before resolving a client', async () => {
    const doc = JSON.stringify({ client_id: 'https://claude.ai/oauth/client-metadata.json', client_name: 'Cimd', redirect_uris: [CB] });
    const fetchImpl = vi.fn(async () => new Response(doc, { status: 200 })) as unknown as typeof fetch;
    await start({ fetchImpl, lookup: async () => [{ address: '93.184.216.34' }] });
    const id = await register();
    const a = { 'X-Forwarded-For': '203.0.113.7' };
    for (let i = 0; i < 10; i++) await postForm({ ...params(id), code: 'BAD' + i }, a);
    const q = new URLSearchParams(params('https://claude.ai/oauth/client-metadata.json'));
    const blocked = await fetch(`${url}/oauth/authorize?${q}`, { redirect: 'manual', headers: a });
    expect(blocked.status).toBe(429);
    expect(fetchImpl).not.toHaveBeenCalled();
    const other = await fetch(`${url}/oauth/authorize?${q}`, { redirect: 'manual', headers: { 'X-Forwarded-For': '203.0.113.8' } });
    expect(other.status).toBe(200);
  });

  it('does not burn a connect code on a request that fails validation', async () => {
    await start();
    const id = await register();
    const { code } = createConnectCode(db, NOW);
    const bad = await postForm({ ...params(id, { redirect_uri: 'https://claude.ai/api/mcp/auth_callback/' }), code });
    expect(bad.status).toBe(400);
    expect((await postForm({ ...params(id), code })).status).toBe(302);
  });
});
