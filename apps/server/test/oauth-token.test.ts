import { createHash, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db.js';
import type { HubScope } from '../src/oauth/config.js';
import { createAuthCode, createGrant, listGrants } from '../src/oauth/store.js';
import { startServer } from './helpers.js';

const CB = 'https://claude.ai/api/mcp/auth_callback';
const CLIENT = 'client-1';
const MCP = 'https://hub.test/mcp';

let close: (() => Promise<void>) | undefined;
let db: Db;
let url: string;
let clock: Date;
const nowIso = (): string => clock.toISOString();
const advance = (ms: number): void => {
  clock = new Date(clock.getTime() + ms);
};

beforeEach(async () => {
  clock = new Date('2026-10-20T12:00:00.000Z');
  db = openDb(':memory:');
  const now = (): Date => clock;
  const s = await startServer({ db, now, oauth: { publicUrl: 'https://hub.test', now } });
  close = s.close;
  url = s.url;
});
afterEach(async () => {
  await close?.();
  close = undefined;
});

interface Issued {
  code: string;
  verifier: string;
  grantId: number;
}

function issueCode(scopes: HubScope[] = ['hub.read', 'offline_access']): Issued {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const grantId = createGrant(db, { clientId: CLIENT, clientName: 'Claude', scopes }, nowIso());
  const code = createAuthCode(db, { grantId, clientId: CLIENT, redirectUri: CB, codeChallenge: challenge, resource: MCP }, nowIso());
  return { code, verifier, grantId };
}

const post = (form: Record<string, string>, contentType = 'application/x-www-form-urlencoded') =>
  fetch(url + '/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body: contentType.includes('json') ? JSON.stringify(form) : new URLSearchParams(form),
  });

const exchange = (i: Issued, over: Record<string, string> = {}) =>
  post({ grant_type: 'authorization_code', code: i.code, code_verifier: i.verifier, client_id: CLIENT, redirect_uri: CB, ...over });
const refresh = (token: string, over: Record<string, string> = {}) =>
  post({ grant_type: 'refresh_token', refresh_token: token, client_id: CLIENT, ...over });
const mcp = (token: string) =>
  fetch(url + '/mcp', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } });

interface Tokens {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
  scope: string;
}
async function ok(res: Response): Promise<Tokens> {
  expect(res.status).toBe(200);
  return (await res.json()) as Tokens;
}
async function errorOf(res: Response, error: string): Promise<void> {
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe(error);
}

describe('POST /oauth/token authorization_code', () => {
  it('exchanges a code with the right verifier', async () => {
    const i = issueCode();
    const res = await exchange(i);
    const t = await ok(res);
    expect(t.token_type).toBe('Bearer');
    expect(t.expires_in).toBe(3600);
    expect(t.scope).toBe('hub.read offline_access');
    expect(t.access_token).toMatch(/^chub_at_/);
    expect(t.refresh_token).toMatch(/^chub_rt_/);
    expect((await mcp(t.access_token)).status).toBe(501);
  });

  it('issues no refresh token without offline_access', async () => {
    const t = await ok(await exchange(issueCode(['hub.read'])));
    expect(t.refresh_token).toBeUndefined();
    expect(t.scope).toBe('hub.read');
  });

  it('accepts a resource equal to the MCP URL', async () => {
    await ok(await exchange(issueCode(), { resource: MCP }));
  });

  it('refuses a wrong or missing verifier', async () => {
    await errorOf(await exchange(issueCode(), { code_verifier: randomBytes(32).toString('base64url') }), 'invalid_grant');
    await errorOf(await exchange(issueCode(), { code_verifier: 'short' }), 'invalid_grant');
    const i = issueCode();
    await errorOf(await post({ grant_type: 'authorization_code', code: i.code, client_id: CLIENT, redirect_uri: CB }), 'invalid_grant');
  });

  it('refuses a wrong redirect_uri', async () => {
    await errorOf(await exchange(issueCode(), { redirect_uri: 'https://claude.com/api/mcp/auth_callback' }), 'invalid_grant');
  });

  it('refuses a wrong client_id', async () => {
    await errorOf(await exchange(issueCode(), { client_id: 'someone-else' }), 'invalid_grant');
  });

  it('refuses a resource that is not the MCP URL', async () => {
    await errorOf(await exchange(issueCode(), { resource: 'https://evil.test/mcp' }), 'invalid_target');
  });

  it('refuses an expired code', async () => {
    const i = issueCode();
    advance(61_000);
    await errorOf(await exchange(i), 'invalid_grant');
  });

  it('refuses an unknown code', async () => {
    const i = issueCode();
    await errorOf(await exchange(i, { code: 'chub_ac_nope' }), 'invalid_grant');
  });

  it('a reused code fails and revokes the grant', async () => {
    const i = issueCode();
    const first = await ok(await exchange(i));
    expect((await mcp(first.access_token)).status).toBe(501);
    await errorOf(await exchange(i), 'invalid_grant');
    expect((await mcp(first.access_token)).status).toBe(401);
    expect(listGrants(db)[0]!.revokedAt).not.toBeNull();
  });
});

describe('POST /oauth/token requests', () => {
  it('refuses JSON', async () => {
    const i = issueCode();
    const res = await post(
      { grant_type: 'authorization_code', code: i.code, code_verifier: i.verifier, client_id: CLIENT, redirect_uri: CB },
      'application/json',
    );
    await errorOf(res, 'invalid_request');
  });

  it('refuses unsupported grant types', async () => {
    await errorOf(await post({ grant_type: 'client_credentials' }), 'unsupported_grant_type');
    await errorOf(await post({}), 'unsupported_grant_type');
  });

  it('sets Cache-Control: no-store on every response', async () => {
    const i = issueCode();
    const good = await exchange(i);
    const t = await ok(good);
    for (const res of [
      good,
      await exchange(i),
      await post({ grant_type: 'nope' }),
      await post({ grant_type: 'authorization_code' }, 'application/json'),
      await refresh(t.refresh_token!),
    ]) {
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('answers a body that cannot be read with invalid_request and no-store', async () => {
    const res = await fetch(url + '/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Encoding': 'gzip' },
      body: 'this is not gzip',
    });
    await errorOf(res, 'invalid_request');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('failures do not count toward the limiter', async () => {
    for (let i = 0; i < 15; i++) await errorOf(await exchange(issueCode(), { code_verifier: 'x'.repeat(50) }), 'invalid_grant');
    const t = await ok(await exchange(issueCode()));
    expect((await mcp(t.access_token)).status).toBe(501);
  });
});

describe('POST /oauth/token refresh_token', () => {
  async function signIn(): Promise<{ t: Tokens; i: Issued }> {
    const i = issueCode();
    return { t: await ok(await exchange(i)), i };
  }

  it('rotates: the new pair works, the old access token lives on, the old refresh token fails after 61 s and revokes the grant', async () => {
    const { t: first } = await signIn();
    advance(5_000);
    const second = await ok(await refresh(first.refresh_token!));
    expect(second.refresh_token).toMatch(/^chub_rt_/);
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(second.scope).toBe('hub.read offline_access');
    expect(second.expires_in).toBe(3600);
    expect((await mcp(second.access_token)).status).toBe(501);
    expect((await mcp(first.access_token)).status).toBe(501);

    advance(61_000);
    await errorOf(await refresh(first.refresh_token!), 'invalid_grant');
    expect(listGrants(db)[0]!.revokedAt).not.toBeNull();
    expect((await mcp(second.access_token)).status).toBe(401);
    await errorOf(await refresh(second.refresh_token!), 'invalid_grant');
  });

  it('racing refreshes within the grace window keep only the last pair', async () => {
    const { t: first } = await signIn();
    advance(1_000);
    const a = await ok(await refresh(first.refresh_token!));
    advance(10_000);
    const b = await ok(await refresh(first.refresh_token!));
    expect(b.refresh_token).not.toBe(a.refresh_token);

    expect((await mcp(b.access_token)).status).toBe(501);
    expect((await mcp(a.access_token)).status).toBe(401);
    await errorOf(await refresh(a.refresh_token!), 'invalid_grant');
    expect(listGrants(db)[0]!.revokedAt).toBeNull();
    const c = await ok(await refresh(b.refresh_token!));
    expect((await mcp(c.access_token)).status).toBe(501);
  });

  it('measures the grace window from the first rotation', async () => {
    const { t: first } = await signIn();
    await ok(await refresh(first.refresh_token!));
    advance(40_000);
    await ok(await refresh(first.refresh_token!));
    advance(30_000); // 70 s after the first rotation
    await errorOf(await refresh(first.refresh_token!), 'invalid_grant');
    expect(listGrants(db)[0]!.revokedAt).not.toBeNull();
  });

  it('treats a second use at exactly 60 s as theft', async () => {
    const { t: first } = await signIn();
    await ok(await refresh(first.refresh_token!));
    advance(60_000);
    await errorOf(await refresh(first.refresh_token!), 'invalid_grant');
    expect(listGrants(db)[0]!.revokedAt).not.toBeNull();
  });

  it('an idle refresh token expires after 90 days', async () => {
    const { t } = await signIn();
    advance(90 * 86_400_000 + 1_000);
    await errorOf(await refresh(t.refresh_token!), 'invalid_grant');
  });

  it('a refresh token used within 90 days of its last use still works', async () => {
    const { t } = await signIn();
    advance(89 * 86_400_000);
    const second = await ok(await refresh(t.refresh_token!));
    advance(89 * 86_400_000);
    await ok(await refresh(second.refresh_token!));
  });

  it('refuses unknown tokens, access tokens, a wrong client, and revoked grants', async () => {
    const { t, i } = await signIn();
    await errorOf(await refresh('chub_rt_nope'), 'invalid_grant');
    await errorOf(await refresh(t.access_token), 'invalid_grant');
    await errorOf(await refresh(t.refresh_token!, { client_id: 'someone-else' }), 'invalid_grant');
    expect(listGrants(db)[0]!.revokedAt).toBeNull();
    const again = await ok(await refresh(t.refresh_token!));
    t.refresh_token = again.refresh_token;
    db.prepare('UPDATE oauth_grants SET revoked_at = ? WHERE id = ?').run(nowIso(), i.grantId);
    await errorOf(await refresh(t.refresh_token!), 'invalid_grant');
  });

  it('refuses a resource that is not the MCP URL', async () => {
    const { t } = await signIn();
    await errorOf(await refresh(t.refresh_token!, { resource: 'https://evil.test/mcp' }), 'invalid_target');
  });
});
