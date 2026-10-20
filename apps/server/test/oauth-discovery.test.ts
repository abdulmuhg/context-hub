import { afterEach, describe, expect, it } from 'vitest';
import { request } from 'node:http';
import { openDb } from '../src/db.js';
import { startServer } from './helpers.js';

const OAUTH = { publicUrl: 'https://hub.test' };
let close: (() => Promise<void>) | undefined;

async function start(oauth: boolean): Promise<string> {
  const s = await startServer({ db: openDb(':memory:'), ...(oauth ? { oauth: OAUTH } : {}) });
  close = s.close;
  return s.url;
}

afterEach(async () => {
  await close?.();
  close = undefined;
});

describe('OAuth discovery', () => {
  it.each(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'])('serves protected resource metadata at %s', async (p) => {
    const url = await start(true);
    const res = await fetch(url + p);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      resource: 'https://hub.test/mcp',
      authorization_servers: ['https://hub.test'],
      scopes_supported: ['hub.read', 'hub.save', 'offline_access'],
    });
  });

  it('serves authorization server metadata', async () => {
    const url = await start(true);
    const res = await fetch(url + '/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toMatchObject({
      issuer: 'https://hub.test',
      authorization_endpoint: 'https://hub.test/oauth/authorize',
      token_endpoint: 'https://hub.test/oauth/token',
      registration_endpoint: 'https://hub.test/oauth/register',
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      client_id_metadata_document_supported: true,
      grant_types_supported: ['authorization_code', 'refresh_token'],
      response_types_supported: ['code'],
    });
  });

  it('metadata ignores the Host header', async () => {
    const url = await start(true);
    const u = new URL(url + '/.well-known/oauth-authorization-server');
    const body = await new Promise<string>((resolve, reject) => {
      const r = request({ host: u.hostname, port: u.port, path: u.pathname, headers: { Host: 'evil.example' } }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve(data));
      });
      r.on('error', reject);
      r.end();
    });
    expect(body).not.toContain('evil.example');
    expect(JSON.parse(body).issuer).toBe('https://hub.test');
  });

  it('without oauth configured, these paths are 404', async () => {
    const url = await start(false);
    for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server', '/oauth/authorize']) {
      const res = await fetch(url + p);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
    }
  });
});
