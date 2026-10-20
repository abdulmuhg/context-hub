import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../src/db.js';
import { resolveClient } from '../src/oauth/clients.js';
import { getClient } from '../src/oauth/store.js';
import type { OAuthConfig } from '../src/oauth/config.js';
import { startServer } from './helpers.js';

const OK = 'https://claude.ai/api/mcp/auth_callback';
const NOW = '2026-10-20T10:00:00.000Z';
const publicLookup = async () => [{ address: '93.184.216.34' }];

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  vi.useRealTimers();
});

async function start(): Promise<string> {
  const s = await startServer({ db: openDb(':memory:'), oauth: { publicUrl: 'https://hub.test', lookup: publicLookup } });
  close = s.close;
  return s.url;
}
const post = (url: string, body: string, type = 'application/json') =>
  fetch(url + '/oauth/register', { method: 'POST', headers: { 'Content-Type': type }, body });

describe('POST /oauth/register (DCR)', () => {
  it('registers a client with an allowed redirect', async () => {
    const url = await start();
    const res = await post(url, JSON.stringify({ client_name: 'Claude', redirect_uris: [OK] }));
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const b = await res.json();
    expect(b.client_id).toEqual(expect.any(String));
    expect(b.client_id_issued_at).toEqual(expect.any(Number));
    expect(b.redirect_uris).toEqual([OK]);
    expect(b.token_endpoint_auth_method).toBe('none');
  });

  it('refuses a foreign redirect', async () => {
    const url = await start();
    const res = await post(url, JSON.stringify({ redirect_uris: ['https://evil.example/cb'] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_redirect_uri');
  });

  it('refuses token_endpoint_auth_method other than none', async () => {
    const url = await start();
    const res = await post(url, JSON.stringify({ redirect_uris: [OK], token_endpoint_auth_method: 'client_secret_basic' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_client_metadata');
  });

  it('refuses a non-JSON body', async () => {
    const url = await start();
    expect((await post(url, 'redirect_uris=x', 'application/x-www-form-urlencoded')).status).toBe(400);
    expect((await post(url, '{not json')).status).toBe(400);
  });

  it('refuses a body over 64 KiB', async () => {
    const url = await start();
    const res = await post(url, JSON.stringify({ redirect_uris: [OK], client_name: 'x'.repeat(70_000) }));
    expect(res.status).toBe(413);
  });
});

describe('resolveClient', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(':memory:');
  });
  const URL_ = 'https://client.example/meta.json';
  const doc = (over: object = {}) => JSON.stringify({ client_id: URL_, client_name: 'Cimd', redirect_uris: [OK], ...over });
  const cfgWith = (fetchImpl: typeof fetch, lookup = publicLookup): OAuthConfig => ({ publicUrl: 'https://hub.test', fetchImpl, lookup });
  const respond = (body: string) => (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;

  it('accepts a document whose client_id equals its URL and lists an allowed redirect', async () => {
    const r = await resolveClient(db, cfgWith(respond(doc())), URL_, NOW);
    expect(r).toMatchObject({ ok: true, client: { clientId: URL_, kind: 'cimd', name: 'Cimd', redirectUris: [OK] } });
    expect(getClient(db, URL_)).not.toBeNull();
  });

  it('refuses a client_id that does not match the URL', async () => {
    const r = await resolveClient(db, cfgWith(respond(doc({ client_id: 'https://other.example/x' }))), URL_, NOW);
    expect(r.ok).toBe(false);
  });

  it('refuses a document with no allowed redirect', async () => {
    const r = await resolveClient(db, cfgWith(respond(doc({ redirect_uris: ['https://evil.example/cb'] }))), URL_, NOW);
    expect(r.ok).toBe(false);
  });

  it('refuses http://', async () => {
    const f = vi.fn(respond(doc({ client_id: 'http://client.example/m' })));
    const r = await resolveClient(db, cfgWith(f), 'http://client.example/m', NOW);
    expect(r.ok).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it('refuses a response over 64 KiB', async () => {
    const r = await resolveClient(db, cfgWith(respond(doc({ pad: 'x'.repeat(70_000) }))), URL_, NOW);
    expect(r.ok).toBe(false);
  });

  it('refuses when the fetch times out after 3 s', async () => {
    vi.useFakeTimers();
    const hang = ((_u: unknown, init?: RequestInit) =>
      new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))))) as unknown as typeof fetch;
    const p = resolveClient(db, cfgWith(hang), URL_, NOW);
    await vi.advanceTimersByTimeAsync(3_000);
    const r = await p;
    expect(r.ok).toBe(false);
  });

  it.each(['localhost', '127.0.0.1', '10.1.2.3', '192.168.1.5', '169.254.169.254', '[::1]', '[::ffff:a00:1]', '[::ffff:7f00:1]', '[::ffff:a9fe:a9fe]', '[::7f00:1]', '[2002:7f00:1::]', '[64:ff9b::a00:1]', 'localhost.'])('refuses a URL whose host is %s', async (host) => {
    const u = `https://${host}/m.json`;
    const f = vi.fn(respond(JSON.stringify({ client_id: u, redirect_uris: [OK] })));
    const r = await resolveClient(db, cfgWith(f), u, NOW);
    expect(r.ok).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it('accepts a public IPv6 literal', async () => {
    const u = 'https://[2606:4700::1111]/m.json';
    const f = vi.fn(respond(JSON.stringify({ client_id: u, redirect_uris: [OK] })));
    const r = await resolveClient(db, cfgWith(f), u, NOW);
    expect(r.ok).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('refuses a name that resolves to a private address', async () => {
    const f = vi.fn(respond(doc()));
    const r = await resolveClient(db, cfgWith(f, async () => [{ address: '93.184.216.34' }, { address: '10.0.0.7' }]), URL_, NOW);
    expect(r.ok).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it('uses the cache within 24 h', async () => {
    const f = vi.fn(respond(doc()));
    const cfg = cfgWith(f);
    await resolveClient(db, cfg, URL_, NOW);
    const r = await resolveClient(db, cfg, URL_, '2026-10-21T09:00:00.000Z');
    expect(r.ok).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
    await resolveClient(db, cfg, URL_, '2026-10-21T10:00:01.000Z');
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('looks anything else up as a DCR client', async () => {
    expect((await resolveClient(db, cfgWith(respond('')), 'nope', NOW)).ok).toBe(false);
  });
});
