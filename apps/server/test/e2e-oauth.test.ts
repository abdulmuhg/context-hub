import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAdmin } from '../src/admin.js';
import { openDb, type Db } from '../src/db.js';
import { handleMcp } from '../src/mcp.js';
import type { OAuthConfig } from '../src/oauth/config.js';
import { createToken } from '../src/tokens.js';
import { gz, makeSession, startServer } from './helpers.js';

const CB = 'https://claude.ai/api/mcp/auth_callback';

let db: Db;
let url: string;
let close: () => Promise<void>;
let ingest: string;

beforeEach(async () => {
  db = openDb(':memory:');
  // The public URL is the server's own address, which is only known once it listens.
  const oauth: OAuthConfig = { publicUrl: 'http://placeholder.invalid' };
  ({ url, close } = await startServer({ db, mcp: handleMcp(db), oauth, log: () => {} }));
  oauth.publicUrl = url;
  ingest = createToken(db, 'collector', 'ingest', new Date().toISOString()).token;
});

afterEach(async () => {
  await close();
});

const mcpPost = (bearer?: string): Promise<Response> =>
  fetch(url + '/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });

async function listProjects(access: string): Promise<string[]> {
  const client = new Client({ name: 'e2e-oauth', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${access}` } } }));
  const result = (await client.callTool({ name: 'list_projects', arguments: {} })) as { content: { text: string }[] };
  await client.close();
  return JSON.parse(result.content[0]!.text).projects.map((p: { key: string }) => p.key);
}

const form = (body: Record<string, string>): RequestInit => ({
  method: 'POST',
  redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body),
});

describe('Claude app sign-in, end to end', () => {
  it('signs in over HTTP the way Claude does, reads the hub, refreshes, and is cut off by revoke', async () => {
    const session = makeSession();
    const upload = await fetch(`${url}/api/sessions/${session.source}/${session.source_session_id}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${ingest}`, 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
      body: gz(session) as BodyInit,
    });
    expect(upload.status).toBeLessThan(300);

    // 1. Unauthenticated /mcp points at the resource metadata.
    const challenge = await mcpPost();
    expect(challenge.status).toBe(401);
    const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge.headers.get('www-authenticate') ?? '')?.[1];
    expect(metadataUrl).toBe(`${url}/.well-known/oauth-protected-resource`);

    // 2. Resource metadata, then authorization server metadata.
    const resource = await (await fetch(url + new URL(metadataUrl!).pathname)).json();
    expect(resource).toMatchObject({ resource: `${url}/mcp`, authorization_servers: [url] });
    const as = await (await fetch(`${url}/.well-known/oauth-authorization-server`)).json();
    expect(as).toMatchObject({ issuer: url, code_challenge_methods_supported: ['S256'] });

    // 3. Dynamic client registration.
    const reg = await fetch(url + new URL(as.registration_endpoint).pathname, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude', redirect_uris: [CB], token_endpoint_auth_method: 'none' }),
    });
    expect(reg.status).toBe(201);
    const clientId: string = (await reg.json()).client_id;

    // 4. Authorization request with PKCE S256.
    const verifier = randomBytes(32).toString('base64url');
    const authParams = {
      client_id: clientId,
      redirect_uri: CB,
      response_type: 'code',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      state: 'st-' + randomBytes(6).toString('hex'),
      scope: 'hub.read hub.save offline_access',
      resource: `${url}/mcp`,
    };
    const authorizeUrl = url + new URL(as.authorization_endpoint).pathname;
    const page = await fetch(`${authorizeUrl}?${new URLSearchParams(authParams)}`, { redirect: 'manual' });
    expect(page.status).toBe(200);

    // 5. The owner mints a connect code with an ingest token and types it in.
    const minted = await fetch(url + '/api/connect-code', { method: 'POST', headers: { Authorization: `Bearer ${ingest}` } });
    expect(minted.status).toBe(200);
    const { code: connectCode } = await minted.json();
    const approved = await fetch(authorizeUrl, form({ ...authParams, code: connectCode, save: 'on' }));
    expect(approved.status).toBe(302);
    const location = new URL(approved.headers.get('location')!);
    expect(`${location.origin}${location.pathname}`).toBe(CB);
    expect(location.searchParams.get('state')).toBe(authParams.state);
    const authCode = location.searchParams.get('code')!;
    expect(authCode).toMatch(/^chub_ac_/);

    // 6. Token exchange.
    const tokenUrl = url + new URL(as.token_endpoint).pathname;
    const tokenRes = await fetch(tokenUrl, form({ grant_type: 'authorization_code', code: authCode, code_verifier: verifier, client_id: clientId, redirect_uri: CB }));
    expect(tokenRes.status).toBe(200);
    const tokens = await tokenRes.json();
    expect(tokens.access_token).toMatch(/^chub_at_/);
    expect(tokens.refresh_token).toMatch(/^chub_rt_/);

    // 7. The access token reads the project uploaded earlier.
    expect(await listProjects(tokens.access_token)).toEqual([session.project_key]);

    // 8. Refresh; the new access token works too.
    const refreshed = await (await fetch(tokenUrl, form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId }))).json();
    expect(refreshed.access_token).toMatch(/^chub_at_/);
    expect(refreshed.access_token).not.toBe(tokens.access_token);
    expect(await listProjects(refreshed.access_token)).toEqual([session.project_key]);

    // 9. Revoking the grant from the admin tool cuts off the access token at once.
    const out: string[] = [];
    expect(await runAdmin(['oauth', 'list'], { db, out: (l) => out.push(l), err: () => {} })).toBe(0);
    expect(out.join('\n')).toContain('Claude');
    expect(out.join('\n')).not.toContain(refreshed.access_token);
    expect((await mcpPost(refreshed.access_token)).status).not.toBe(401);
    expect(await runAdmin(['oauth', 'revoke', '1'], { db, out: () => {}, err: () => {} })).toBe(0);
    expect((await mcpPost(refreshed.access_token)).status).toBe(401);
  });
});
