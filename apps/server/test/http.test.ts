import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { openDb, type Db } from '../src/db.js';
import { MAX_BODY, send } from '../src/http.js';
import { AuthLimiter } from '../src/ratelimit.js';
import { createGrant, issueTokens, listGrants } from '../src/oauth/store.js';
import { latestSyncRun, listActivity } from '../src/activity.js';
import { createToken, revokeToken } from '../src/tokens.js';
import { contentHash } from '@context-hub/core';
import { getProjectState, nextDueDigest, saveProjectState } from '../src/digest-store.js';
import { gz, makeSession, startServer, text } from './helpers.js';

const NOW = new Date('2026-10-11T00:00:00.000Z');
let db: Db;
let url: string;
let close: () => Promise<void>;
let ingest: string;
let read: string;
let logs: string[];

const call = (method: string, path: string, opts: { token?: string; body?: Buffer | string; headers?: Record<string, string> } = {}) =>
  fetch(url + path, {
    method,
    headers: { ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}), ...(opts.headers ?? {}) },
    body: opts.body as BodyInit | undefined,
  });

const put = (session = makeSession(), token = ingest, path?: string) =>
  call('PUT', path ?? `/api/sessions/${session.source}/${encodeURIComponent(session.source_session_id)}`, {
    token,
    body: gz(session),
    headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
  });

beforeEach(async () => {
  db = openDb(':memory:');
  logs = [];
  ingest = createToken(db, 'collector', 'ingest', NOW.toISOString()).token;
  read = createToken(db, 'assistant', 'read', NOW.toISOString()).token;
  ({ url, close } = await startServer({
    db,
    now: () => NOW,
    limiter: new AuthLimiter(),
    log: (l) => logs.push(l),
    web: { imageTag: null, startedAt: NOW.toISOString(), digestsOn: false, backupStatusPath: null, secureCookies: false, publicOrigin: null, dailyBudgetUsd: null },
  }));
});

afterEach(async () => {
  await close();
});

describe('health and unknown routes', () => {
  it('healthz answers without a token', async () => {
    const res = await call('GET', '/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('unknown paths are 404 JSON', async () => {
    const res = await call('GET', '/nope', { token: read });
    expect(res.status).toBe(404);
    expect(await res.json()).toHaveProperty('error');
  });
});

describe('access control', () => {
  it('401 without a token, with a malformed header, or with an unknown token', async () => {
    expect((await call('GET', '/api/status')).status).toBe(401);
    expect((await call('GET', '/api/status', { headers: { Authorization: 'Basic abc' } })).status).toBe(401);
    expect((await call('GET', '/api/status', { token: 'chub_wrong' })).status).toBe(401);
  });

  it('403 when the scope is wrong', async () => {
    expect((await put(makeSession(), read)).status).toBe(403);
    expect((await call('DELETE', '/api/projects/x', { token: read })).status).toBe(403);
    expect((await call('POST', '/mcp', { token: ingest, body: '{}' })).status).toBe(403);
  });

  it('status accepts either scope', async () => {
    expect((await call('GET', '/api/status', { token: read })).status).toBe(200);
    expect((await call('GET', '/api/status', { token: ingest })).status).toBe(200);
  });

  it('429 after 10 failed attempts from one address; a valid token still passes', async () => {
    for (let i = 0; i < 10; i++) await call('GET', '/api/status', { token: 'chub_bad', headers: { 'X-Forwarded-For': '9.9.9.9' } });
    const blocked = await call('GET', '/api/status', { token: 'chub_bad', headers: { 'X-Forwarded-For': '9.9.9.9' } });
    expect(blocked.status).toBe(429);
    expect((await call('GET', '/api/status', { token: read, headers: { 'X-Forwarded-For': '9.9.9.9' } })).status).toBe(200);
    const other = await call('GET', '/api/status', { token: read, headers: { 'X-Forwarded-For': '8.8.8.8' } });
    expect(other.status).toBe(200);
  });

  it('uses the first address in X-Forwarded-For', async () => {
    for (let i = 0; i < 10; i++) await call('GET', '/api/status', { token: 'chub_bad', headers: { 'X-Forwarded-For': '7.7.7.7, 10.0.0.1' } });
    expect((await call('GET', '/api/status', { token: 'chub_bad', headers: { 'X-Forwarded-For': '7.7.7.7' } })).status).toBe(429);
  });
});

describe('POST /api/connect-code', () => {
  it('connect-code needs an ingest token', async () => {
    expect((await call('POST', '/api/connect-code', { token: read })).status).toBe(403);
    expect((await call('POST', '/api/connect-code')).status).toBe(401);
    const res = await call('POST', '/api/connect-code', { token: ingest });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: string; expires_at: string };
    expect(body.code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/);
    expect(body.expires_at).toBe(new Date(NOW.getTime() + 10 * 60_000).toISOString());
  });
});

describe('PUT /api/sessions', () => {
  it('stores a session and reports the change', async () => {
    const res = await put();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stored: true, changed: true, server_redactions: 0 });
    expect((await (await call('GET', '/api/status', { token: read })).json()).sessions).toBe(1);
  });

  it('remembers which computer uploads the project, even when nothing changed', async () => {
    await put();
    db.prepare('DELETE FROM project_uploaders').run();
    await put();
    expect(db.prepare('SELECT u.project_key, t.label FROM project_uploaders u JOIN tokens t ON t.id = u.token_id').all()).toEqual([
      { project_key: makeSession().project_key, label: 'collector' },
    ]);
  });

  it('is idempotent', async () => {
    await put();
    expect(await (await put()).json()).toMatchObject({ changed: false });
  });

  it('accepts an id containing a slash', async () => {
    const sub = makeSession({ source_session_id: 'main/agent-1', parent: 'main' });
    expect((await put(sub)).status).toBe(200);
    expect(db.prepare('SELECT source_session_id FROM sessions').get()).toEqual({ source_session_id: 'main/agent-1' });
  });

  it('accepts an uncompressed JSON body too', async () => {
    const s = makeSession();
    const res = await call('PUT', `/api/sessions/${s.source}/${s.source_session_id}`, {
      token: ingest,
      body: JSON.stringify(s),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(200);
  });

  it('the ingest API refuses source note', async () => {
    const base = makeSession({ source_session_id: 'x' });
    const note = { ...base, source: 'note' as never };
    const res = await put({ ...note, content_hash: contentHash(note) }, ingest, '/api/sessions/note/x');
    expect(res.status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
  });

  it('accepts a document whose id holds a project key and a path', async () => {
    const id = 'github.com/me/alpha#knowledge/tickets/T-1.md';
    const doc = makeSession({ source: 'doc', source_session_id: id });
    const res = await put(doc, ingest, `/api/sessions/doc/${encodeURIComponent(id)}`);
    expect(res.status).toBe(200);
    expect(db.prepare('SELECT source, source_session_id FROM sessions').get()).toEqual({ source: 'doc', source_session_id: id });
  });

  // Review Focus 2
  it('400 when the URL and the body name different sessions', async () => {
    const s = makeSession();
    expect((await put(s, ingest, '/api/sessions/claude-code/other-id')).status).toBe(400);
    expect((await put(s, ingest, `/api/sessions/codex/${s.source_session_id}`)).status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
  });

  it.each([
    ['not JSON', Buffer.from('{oops')],
    ['an array', Buffer.from('[]')],
    ['a missing title', Buffer.from(JSON.stringify({ ...makeSession(), title: undefined }))],
    ['an unknown source', Buffer.from(JSON.stringify({ ...makeSession(), source: 'cursor' }))],
    ['a message with a bad kind', Buffer.from(JSON.stringify({ ...makeSession(), messages: [{ seq: 0, role: 'user', kind: 'video', ts: null }] }))],
    ['a text message without text', Buffer.from(JSON.stringify({ ...makeSession(), messages: [{ seq: 0, role: 'user', kind: 'text', ts: null }] }))],
    ['a missing hash', Buffer.from(JSON.stringify({ ...makeSession(), content_hash: '' }))],
  ])('400 for %s', async (_name, body) => {
    const res = await call('PUT', '/api/sessions/claude-code/s1', { token: ingest, body, headers: { 'Content-Type': 'application/json' } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toEqual(expect.any(String));
  });

  it('400 for a body marked gzip that is not gzip', async () => {
    const res = await call('PUT', '/api/sessions/claude-code/s1', { token: ingest, body: 'plain', headers: { 'Content-Encoding': 'gzip' } });
    expect(res.status).toBe(400);
  });

  // Review Focus 3
  it('413 for a small gzip body that expands past the limit', async () => {
    const bomb = gzipSync(Buffer.alloc(MAX_BODY + 1024, 0x61));
    expect(bomb.length).toBeLessThan(1024 * 1024);
    const res = await call('PUT', '/api/sessions/claude-code/s1', { token: ingest, body: bomb, headers: { 'Content-Encoding': 'gzip' } });
    expect(res.status).toBe(413);
  });

  it('strips a secret an out-of-date collector let through, and logs only the count', async () => {
    const secret = 'gh' + 'p_' + 'a'.repeat(36);
    const s = makeSession({ title: `use ${secret}`, messages: [text(0, 'user', `token ${secret}`)] });
    const res = await put(s);
    expect(await res.json()).toMatchObject({ stored: true, server_redactions: 2 });
    const dump = JSON.stringify([db.prepare('SELECT * FROM sessions').all(), db.prepare('SELECT * FROM messages').all(), db.prepare('SELECT * FROM search_index').all()]);
    expect(dump).not.toContain(secret);
    expect(dump).toContain('[REDACTED:github]');
    expect(logs.join('\n')).toMatch(/server stripped 2 secret/);
    expect(logs.join('\n')).not.toContain(secret);
  });
});

describe('DELETE', () => {
  it('removes one session', async () => {
    await put();
    const res = await call('DELETE', '/api/sessions/claude-code/s1', { token: ingest });
    expect(await res.json()).toEqual({ deleted: 1 });
    expect((await (await call('GET', '/api/status', { token: read })).json()).sessions).toBe(0);
  });

  it('removes a project whose key contains slashes', async () => {
    await put();
    const res = await call('DELETE', `/api/projects/${encodeURIComponent('github.com/me/alpha')}`, { token: ingest });
    expect(await res.json()).toEqual({ deleted: 1 });
  });

  it('reports 0 for something that is not there', async () => {
    expect(await (await call('DELETE', '/api/sessions/claude-code/nope', { token: ingest })).json()).toEqual({ deleted: 0 });
  });
});

describe('/mcp before Task 7 wires it', () => {
  it('405 for GET and DELETE, 501 for POST', async () => {
    expect((await call('GET', '/mcp', { token: read })).status).toBe(405);
    expect((await call('DELETE', '/mcp', { token: read })).status).toBe(405);
    expect((await call('POST', '/mcp', { token: read, body: '{}', headers: { 'Content-Type': 'application/json' } })).status).toBe(501);
  });
});

describe('review fixes', () => {
  it('400, not 500, for a malformed percent-encoding in the address', async () => {
    expect((await call('PUT', '/api/sessions/claude-code/%E0%A4%A', { token: ingest, body: '{}' })).status).toBe(400);
    expect((await call('DELETE', '/api/projects/%ZZ', { token: ingest })).status).toBe(400);
    expect(logs.join('\n')).not.toMatch(/URIError/);
  });

  it('400, not 500, when two messages share a seq', async () => {
    const s = makeSession({ messages: [text(0, 'user', 'a'), text(0, 'user', 'b')] });
    const res = await put(s);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/seq/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
  });

  it('answers HEAD /healthz, which container health checks use', async () => {
    const res = await call('HEAD', '/healthz');
    expect(res.status).toBe(200);
  });

  it('discards a body it refused without reading, so the client gets its answer and the next request is not stuck', async () => {
    const huge = Buffer.alloc(MAX_BODY + 1024 * 1024, 0x20);
    const refused = await call('PUT', '/api/sessions/claude-code/s1', { body: huge });
    expect(refused.status).toBe(401);
    const tooBig = await call('PUT', '/api/sessions/claude-code/s1', { token: ingest, body: huge });
    expect(tooBig.status).toBe(413);
    const next = await Promise.race([
      call('GET', '/healthz').then((r) => r.status),
      new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 4000)),
    ]);
    expect(next).toBe(200);
  }, 20000);
});

describe('the bare address', () => {
  const bare = (method: string) => fetch(url + '/', { method, redirect: 'manual' });

  it('sends a browser without a session to the sign-in page, without a token', async () => {
    const res = await bare('GET');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });

  it('gives nothing away: no counts, versions, projects or paths to data', async () => {
    await put();
    expect((await bare('GET')).headers.get('location')).toBe('/login');
    // The redirect carries no body, so the claim is tested against the page it points at.
    const text = await (await call('GET', '/login')).text();
    expect(text.length).toBeGreaterThan(100);
    expect(text).not.toMatch(/alpha|session|sqlite|token|version|\d{2,}/i);
  });

  it('answers HEAD too, and other paths are still 404', async () => {
    expect((await bare('HEAD')).status).toBe(302);
    expect((await call('GET', '/index.html')).status).toBe(404);
  });

  it('refuses a POST without a session instead of 404ing it', async () => {
    expect((await bare('POST')).status).toBe(403);
  });
});

describe('the activity log: uploads and deletes', () => {
  const rows = () => listActivity(db, { limit: 50, offset: 0 });

  it('an upload that changes something logs one row, naming the PC', async () => {
    await put(makeSession({ title: 'Fix the login bug' }));
    expect(rows()).toEqual([
      {
        id: expect.any(Number),
        at: NOW.toISOString(),
        direction: 'in',
        action: 'upload',
        projectKey: 'github.com/me/alpha',
        sessionRef: 'claude-code:s1',
        actor: 'collector',
        detail: 'Fix the login bug',
      },
    ]);
  });

  it('cuts a long title to 100 characters', async () => {
    await put(makeSession({ title: 'x'.repeat(150) }));
    expect(rows()[0]!.detail).toBe('x'.repeat(100));
  });

  it('an unchanged re-upload logs nothing', async () => {
    await put();
    await put();
    expect(rows()).toHaveLength(1);
  });

  it('deleting a session removes its earlier rows and leaves one delete row without a session ref', async () => {
    await put();
    await put(makeSession({ source_session_id: 's2' }));
    const res = await call('DELETE', '/api/sessions/claude-code/s1', { token: ingest });
    expect(res.status).toBe(200);
    const after = rows();
    expect(after.filter((r) => r.sessionRef === 'claude-code:s1')).toEqual([]);
    expect(after.filter((r) => r.action === 'upload').map((r) => r.sessionRef)).toEqual(['claude-code:s2']);
    const del = after.filter((r) => r.action === 'delete');
    expect(del).toHaveLength(1);
    expect(del[0]).toMatchObject({ direction: 'in', projectKey: 'github.com/me/alpha', sessionRef: null, actor: 'collector' });
  });

  it('deleting a project removes all its rows and logs a delete with no project', async () => {
    await put();
    await put(makeSession({ source_session_id: 's9', project_key: 'local:other' }));
    const res = await call('DELETE', `/api/projects/${encodeURIComponent('github.com/me/alpha')}`, { token: ingest });
    expect(res.status).toBe(200);
    const after = rows();
    expect(after.filter((r) => r.projectKey === 'github.com/me/alpha')).toEqual([]);
    expect(after.filter((r) => r.action === 'delete')).toMatchObject([{ direction: 'in', projectKey: null, sessionRef: null }]);
    expect(after.filter((r) => r.action === 'upload')).toHaveLength(1);
  });

  it('a failure to log never fails the request', async () => {
    db.exec('DROP TABLE activity');
    const res = await put();
    expect(res.status).toBe(200);
    expect(logs.some((l) => l.includes('activity'))).toBe(true);
  });
});

describe('the caller passed to the MCP handler', () => {
  const OAUTH = { publicUrl: 'https://hub.test' };
  let cUrl: string;
  let cClose: () => Promise<void>;
  let callers: { canSave: boolean; actor: string }[];

  const oauthToken = (scopes: ('hub.read' | 'hub.save')[]): string => {
    const grantId = createGrant(db, { clientId: 'client-1', clientName: 'Claude', scopes }, NOW.toISOString());
    return issueTokens(db, grantId, false, NOW.toISOString()).access;
  };

  const post = (token: string) =>
    fetch(cUrl + '/mcp', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } });

  beforeEach(async () => {
    callers = [];
    ({ url: cUrl, close: cClose } = await startServer({
      db,
      now: () => NOW,
      oauth: OAUTH,
      mcp: async (_req, res, _body, caller) => {
        callers.push(caller);
        send(res, 200, { ok: true });
      },
    }));
  });
  afterEach(async () => {
    await cClose();
  });

  it('an OAuth grant with hub.save gets canSave; without it, or with a bearer token, it does not', async () => {
    expect((await post(oauthToken(['hub.read', 'hub.save']))).status).toBe(200);
    expect((await post(oauthToken(['hub.read']))).status).toBe(200);
    expect((await post(read)).status).toBe(200);
    expect(callers).toEqual([
      { canSave: true, actor: 'Claude' },
      { canSave: false, actor: 'Claude' },
      { canSave: false, actor: 'read token: assistant' },
    ]);
  });
});

describe('limiter rules', () => {
  const OAUTH = { publicUrl: 'https://hub.test' };
  let oUrl: string;
  let oClose: () => Promise<void>;
  let nowIso: string;

  const oauthToken = (scopes: ('hub.read' | 'hub.save')[], issuedAt: string): string => {
    const grantId = createGrant(db, { clientId: 'client-1', clientName: 'Claude', scopes }, issuedAt);
    return issueTokens(db, grantId, false, issuedAt).access;
  };
  const mcp = (token?: string, headers: Record<string, string> = {}) =>
    fetch(oUrl + '/mcp', {
      method: 'POST',
      body: '{}',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    });

  beforeEach(async () => {
    nowIso = NOW.toISOString();
    ({ url: oUrl, close: oClose } = await startServer({ db, now: () => NOW, limiter: new AuthLimiter(() => 0), oauth: OAUTH }));
  });
  afterEach(async () => {
    await oClose();
  });

  it('requests without an Authorization header never count', async () => {
    for (let i = 0; i < 50; i++) expect((await mcp()).status).toBe(401);
    expect((await mcp(read)).status).not.toBe(429);
    expect((await mcp(read)).status).toBe(501);
  });

  it('a valid token passes even from a blocked address', async () => {
    const h = { 'X-Forwarded-For': '5.5.5.5' };
    for (let i = 0; i < 10; i++) expect((await mcp('chub_unknown', h)).status).toBe(401);
    expect((await mcp('chub_unknown', h)).status).toBe(429);
    expect((await mcp(read, h)).status).not.toBe(429);
  });

  it('a stale hub-issued token gets 401 with the challenge even from a blocked address', async () => {
    const h = { 'X-Forwarded-For': '7.7.7.7' };
    for (let i = 0; i < 10; i++) await mcp('chub_unknown', h);
    expect((await mcp('chub_unknown', h)).status).toBe(429);
    const expired = oauthToken(['hub.read'], '2026-10-10T00:00:00.000Z');
    const res = await mcp(expired, h);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate') ?? '').toContain('error="invalid_token"');
  });

  it('an expired hub-issued access token does not count', async () => {
    const expired = oauthToken(['hub.read'], '2026-10-10T00:00:00.000Z');
    for (let i = 0; i < 20; i++) expect((await mcp(expired)).status).toBe(401);
    expect((await mcp(read)).status).not.toBe(429);
  });

  it('a revoked ingest or read token does not count either', async () => {
    const { id, token } = createToken(db, 'old', 'read', nowIso);
    revokeToken(db, id, nowIso);
    for (let i = 0; i < 20; i++) expect((await mcp(token)).status).toBe(401);
    expect((await mcp(read)).status).not.toBe(429);
  });

  it('/mcp 401 carries WWW-Authenticate when oauth is configured', async () => {
    const challenge = 'Bearer resource_metadata="https://hub.test/.well-known/oauth-protected-resource"';
    expect((await mcp()).headers.get('www-authenticate')).toBe(challenge);
    const wrong = (await mcp('chub_wrong')).headers.get('www-authenticate') ?? '';
    expect(wrong).toContain(challenge.slice('Bearer '.length));
    expect(wrong).toContain('error="invalid_token"');
    const plain = await call('POST', '/mcp', { body: '{}' });
    expect(plain.status).toBe(401);
    expect(plain.headers.get('www-authenticate')).toBeNull();
  });

  it('/mcp/ with a trailing slash answers exactly like /mcp', async () => {
    const slash = (token?: string) =>
      fetch(oUrl + '/mcp/', {
        method: 'POST',
        body: '{}',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      });
    const none = await slash();
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toBe('Bearer resource_metadata="https://hub.test/.well-known/oauth-protected-resource"');
    expect((await slash(oauthToken(['hub.read'], nowIso))).status).toBe(501);
    expect((await slash(ingest)).status).toBe(403);
    expect((await fetch(oUrl + '/mcp/', { headers: { Authorization: `Bearer ${read}` } })).status).toBe(405);
  });

  it('an OAuth access token with hub.read can call /mcp; an ingest bearer still cannot (403)', async () => {
    const at = oauthToken(['hub.read'], nowIso);
    expect((await mcp(at)).status).toBe(501);
    expect((await mcp(ingest)).status).toBe(403);
  });

  it('an OAuth token is not accepted outside /mcp', async () => {
    const at = oauthToken(['hub.read'], nowIso);
    expect((await fetch(oUrl + '/api/status', { headers: { Authorization: `Bearer ${at}` } })).status).toBe(403);
  });

  it('a refresh token presented as a bearer is unknown and counts as a failure', async () => {
    const grantId = createGrant(db, { clientId: 'client-1', clientName: 'Claude', scopes: ['hub.read'] }, nowIso);
    const rt = issueTokens(db, grantId, true, nowIso).refresh!;
    const h = { 'X-Forwarded-For': '6.6.6.6' };
    for (let i = 0; i < 10; i++) expect((await mcp(rt, h)).status).toBe(401);
    expect((await mcp(rt, h)).status).toBe(429);
  });

  it('records the last use on the grant', async () => {
    const at = oauthToken(['hub.read'], '2026-10-11T00:00:00.000Z');
    await mcp(at);
    expect(listGrants(db)[0]!.lastUsedAt).toBe(nowIso);
  });
});

describe('POST /api/sync-runs', () => {
  const report = (token: string | undefined, body: unknown) =>
    call('POST', '/api/sync-runs', { token, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  const good = { finished_at: '2026-10-10T12:00:00.000Z', uploaded: 2, unchanged: 5, errors: 0 };

  it('refuses a read token (403) and a missing token (401)', async () => {
    expect((await report(read, good)).status).toBe(403);
    expect((await report(undefined, good)).status).toBe(401);
    expect(latestSyncRun(db)).toBeNull();
  });

  it('rejects a bad body with 400', async () => {
    for (const bad of [
      { ...good, uploaded: -1 },
      { ...good, unchanged: 1.5 },
      { ...good, errors: '0' },
      { uploaded: 1, unchanged: 1, errors: 0 },
      { ...good, finished_at: 'yesterday' },
      null,
    ]) {
      expect((await report(ingest, bad)).status).toBe(400);
    }
    expect(latestSyncRun(db)).toBeNull();
  });

  it('stores a valid report from the ingest token and answers 204', async () => {
    const res = await report(ingest, good);
    expect(res.status).toBe(204);
    expect(latestSyncRun(db)).toMatchObject({ finishedAt: good.finished_at, uploaded: 2, unchanged: 5, errors: 0 });
  });

  const skips = () => db.prepare('SELECT project_key, reason, at FROM page_skips ORDER BY project_key').all();

  it('replaces the pages this computer last left when the report lists them', async () => {
    await report(ingest, { ...good, pages_left: [{ project: 'p1', reason: 'Claude usage limit reached' }, { project: 'p2', reason: 'r2' }] });
    expect(skips()).toEqual([
      { project_key: 'p1', reason: 'Claude usage limit reached', at: good.finished_at },
      { project_key: 'p2', reason: 'r2', at: good.finished_at },
    ]);
    await report(ingest, { ...good, pages_left: [] });
    expect(skips()).toEqual([]);
  });

  it('keeps what it last heard when a report has no pages_left', async () => {
    await report(ingest, { ...good, pages_left: [{ project: 'p1', reason: 'r1' }] });
    await report(ingest, good);
    expect(skips()).toHaveLength(1);
  });

  it('rejects a malformed pages_left with 400', async () => {
    for (const bad of ['p1', [{ project: 'p1' }], [{ project: '', reason: 'r' }]]) {
      expect((await report(ingest, { ...good, pages_left: bad })).status).toBe(400);
    }
    expect(latestSyncRun(db)).toBeNull();
  });
});

describe('summaries written on the computer', () => {
  const BODY = { goal: 'fix login', done: [{ text: 'patched the cookie check', seq: 1 }], decisions: [{ what: 'Keep sessions', why: 'users stay signed in', seq: 0 }], open_items: [], key_refs: ['src/auth.ts'] };
  const sessionPath = (s = makeSession()) => `/api/sessions/${s.source}/${encodeURIComponent(s.source_session_id)}`;
  const putWith = (session: ReturnType<typeof makeSession>, digest: unknown, token = ingest) =>
    call('PUT', sessionPath(session), {
      token,
      body: gz({ ...session, digest }),
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
    });
  const row = (id = 's1') =>
    db
      .prepare(
        `SELECT d.status, d.model, d.written_by, d.text, d.summary_to_follow FROM digests d JOIN sessions s ON s.id = d.session_id WHERE s.source_session_id = ?`,
      )
      .get(id) as { status: string; model: string | null; written_by: string | null; text: string | null; summary_to_follow: number };

  it('stores a session and its digest in one upload', async () => {
    const res = await putWith(makeSession(), { body: BODY, model: 'claude-sonnet-5-5' });
    expect(res.status).toBe(200);
    expect(row()).toMatchObject({ status: 'ok', model: 'claude-sonnet-5-5', written_by: 'collector' });
    expect(row().text).toContain('Goal: fix login');
    expect(nextDueDigest(db, NOW.toISOString())).toBeNull();
  });

  it('a main session without a digest becomes pending (older collectors)', async () => {
    await put();
    expect(row()).toMatchObject({ status: 'pending', summary_to_follow: 0 });
  });

  it('summary_to_follow removes the old summary and marks the page dirty', async () => {
    const first = makeSession();
    await putWith(first, { body: { ...BODY, goal: 'zebracrossing goal' }, model: 'claude-sonnet-5-5' });
    const project = (db.prepare('SELECT id FROM projects').get() as { id: number }).id;
    saveProjectState(db, project, { summary: 's', body: 'b', model: 'm' }, NOW.toISOString(), true);
    const changed = makeSession({ messages: [text(0, 'user', 'the login page throws a redirect loop'), text(1, 'assistant', 'Found it, and changed.')] });
    expect((await putWith(changed, { summary_to_follow: true })).status).toBe(200);
    expect(row()).toMatchObject({ status: 'pending', text: null, summary_to_follow: 1 });
    expect(db.prepare("SELECT 1 FROM search_index WHERE search_index MATCH 'zebracrossing' AND kind = 'digest'").all()).toEqual([]);
    expect(getProjectState(db, project)!.dirty).toBe(true);
    expect(nextDueDigest(db, NOW.toISOString())).toBeNull();
  });

  it('strips a secret from a digest that came with an upload, and from one sent alone', async () => {
    const secret = 'gh' + 'p_' + 'b'.repeat(36);
    await putWith(makeSession(), {
      body: { ...BODY, goal: `use ${secret}`, decisions: [{ what: 'Keep it', why: `it is ${secret}`, seq: 0 }], key_refs: [secret] },
      model: 'claude-sonnet-5-5',
    });
    const s2 = makeSession({ source_session_id: 's2' });
    await put(s2);
    await call('PUT', `${sessionPath(s2)}/digest`, { token: ingest, body: JSON.stringify({ hash: s2.content_hash, digest: { body: { ...BODY, goal: secret }, model: 'm' } }) });
    await putWith(makeSession({ source_session_id: 's3' }), { refused: `because ${secret}`, model: 'm' });
    const dump = JSON.stringify([db.prepare('SELECT * FROM digests').all(), db.prepare('SELECT * FROM search_index').all()]);
    expect(dump).not.toContain(secret);
    expect(dump).toContain('[REDACTED:github]');
    expect(logs.join('\n')).toMatch(/server stripped \d+ secret\(s\) from its summary/);
  });

  it('rejects a digest body that does not match the schema with 400', async () => {
    const res = await putWith(makeSession(), { body: { goal: 'x' }, model: 'm' });
    expect(res.status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
  });

  it('keeps a refused or failed marker with the upload', async () => {
    await putWith(makeSession(), { refused: 'policy', model: 'claude-sonnet-5-5' });
    expect(row()).toMatchObject({ status: 'refused' });
    await putWith(makeSession({ source_session_id: 's2' }), { failed: 'timed out 3 times' });
    expect(row('s2')).toMatchObject({ status: 'failed' });
  });

  it('PUT digest saves a digest alone, and answers 409 when the hash moved', async () => {
    const s = makeSession();
    await put(s);
    const ok = await call('PUT', `${sessionPath(s)}/digest`, { token: ingest, body: JSON.stringify({ hash: s.content_hash, digest: { body: BODY, model: 'm' } }) });
    expect(ok.status).toBe(204);
    expect(row()).toMatchObject({ status: 'ok', written_by: 'collector' });
    const moved = await call('PUT', `${sessionPath(s)}/digest`, { token: ingest, body: JSON.stringify({ hash: 'f'.repeat(64), digest: { body: BODY, model: 'm' } }) });
    expect(moved.status).toBe(409);
    expect(await moved.json()).toEqual({ error: 'The session changed since this summary was written' });
  });

  it('GET session returns the stored messages', async () => {
    const s = makeSession();
    await put(s);
    const res = await call('GET', sessionPath(s), { token: ingest });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { session: unknown }).session).toEqual(s);
    expect((await call('GET', '/api/sessions/claude-code/nope', { token: ingest })).status).toBe(404);
  });

  it('GET project digests lists writer and model', async () => {
    await putWith(makeSession(), { body: BODY, model: 'claude-sonnet-5-5' });
    await put(makeSession({ source_session_id: 's2' }));
    await put(makeSession({ source_session_id: 's2/agent-1', parent: 's2' }));
    const res = await call('GET', '/api/projects/github.com%2Fme%2Falpha/digests', { token: ingest });
    expect(res.status).toBe(200);
    const { sessions } = (await res.json()) as { sessions: { source: string; id: string; status: string; model: string | null; written_by: string | null; summary_to_follow: boolean }[] };
    expect(sessions.map((x) => x.id).sort()).toEqual(['s1', 's2']);
    expect(sessions.find((x) => x.id === 's1')).toMatchObject({ source: 'claude-code', status: 'ok', model: 'claude-sonnet-5-5', written_by: 'collector', summary_to_follow: false });
    expect(sessions.find((x) => x.id === 's2')).toMatchObject({ status: 'pending', written_by: null });
  });

  it('status reports server_summaries, pages_needed and summaries_owed', async () => {
    await putWith(makeSession(), { body: BODY, model: 'm' });
    await putWith(makeSession({ source_session_id: 's2' }), { summary_to_follow: true });
    const body = await (await call('GET', '/api/status', { token: ingest })).json();
    expect(body).toMatchObject({ server_summaries: false, pages_needed: ['github.com/me/alpha'], summaries_owed: 1 });
  });

  it('a read token cannot use the new routes', async () => {
    const s = makeSession();
    await put(s);
    expect((await call('GET', sessionPath(s), { token: read })).status).toBe(403);
    expect((await call('PUT', `${sessionPath(s)}/digest`, { token: read, body: '{}' })).status).toBe(403);
    expect((await call('GET', '/api/projects/github.com%2Fme%2Falpha/digests', { token: read })).status).toBe(403);
  });
});

describe('state pages written on the computer', () => {
  const BODY = { goal: 'fix login', done: [], decisions: [], open_items: [], key_refs: [] };
  const KEY = 'github.com%2Fme%2Falpha';
  const withDigest = (id: string, activity: string) =>
    call('PUT', `/api/sessions/claude-code/${id}`, {
      token: ingest,
      body: gz({ ...makeSession({ source_session_id: id, last_activity_at: activity }), digest: { body: { ...BODY, goal: `goal of ${id}` }, model: 'claude-sonnet-5-5' } }),
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
    });
  const inputs = async () => (await (await call('GET', `/api/projects/${KEY}/page-inputs`, { token: ingest })).json()) as {
    page: { version: number; digests_through: number; dirty: boolean } | null;
    digests: { session_id: string; title: string; date: string | null; text: string; saved_seq: number }[];
    through: number;
  };
  const savePage = (over: Record<string, unknown> = {}) =>
    call('PUT', `/api/projects/${KEY}/page`, {
      token: ingest,
      body: JSON.stringify({ summary: 'S', body: 'B', model: 'claude-sonnet-5-5', base_version: null, full_rebuild: true, through: 2, ...over }),
    });
  const needed = async () => ((await (await call('GET', '/api/status', { token: ingest })).json()) as { pages_needed: string[] }).pages_needed;

  it('page-inputs returns all ok digests oldest first with their saved_seq', async () => {
    await withDigest('new', '2026-10-05T00:00:00.000Z');
    await withDigest('old', '2026-10-01T00:00:00.000Z');
    await put(makeSession({ source_session_id: 'pending-one' }));
    const r = await inputs();
    expect(r.page).toBeNull();
    expect(r.digests.map((d) => [d.session_id, d.saved_seq])).toEqual([
      ['claude-code:old', 2],
      ['claude-code:new', 1],
    ]);
    expect(r.digests[0]).toMatchObject({ title: 'Fix the login bug', date: '2026-10-01T00:00:00.000Z' });
    expect(r.digests[0]!.text).toContain('Goal: goal of old');
    expect(r.through).toBe(2);
    expect((await call('GET', '/api/projects/nope/page-inputs', { token: ingest })).status).toBe(404);
  });

  it('saving with the current version succeeds and clears pages_needed for that project', async () => {
    await withDigest('a', '2026-10-01T00:00:00.000Z');
    await withDigest('b', '2026-10-02T00:00:00.000Z');
    expect(await needed()).toEqual(['github.com/me/alpha']);
    const res = await savePage();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: 1 });
    expect(await needed()).toEqual([]);
    expect((await inputs()).page).toMatchObject({ version: 1, digests_through: 2, dirty: false });
  });

  it('strips a secret from a page a computer saves, and logs only the count', async () => {
    const secret = 'gh' + 'p_' + 'b'.repeat(36);
    await withDigest('a', '2026-10-01T00:00:00.000Z');
    expect((await savePage({ summary: `uses ${secret}`, body: `## Current state\n- token ${secret}`, through: 1 })).status).toBe(200);
    const dump = JSON.stringify(db.prepare('SELECT * FROM project_states').all());
    expect(dump).not.toContain(secret);
    expect(dump).toContain('[REDACTED:github]');
    expect(logs.join('\n')).toMatch(/server stripped 2 secret\(s\) from its page/);
  });

  it('saving with an old version answers 409', async () => {
    await withDigest('a', '2026-10-01T00:00:00.000Z');
    await savePage({ through: 1 });
    const stale = await savePage({ base_version: null, through: 1 });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: 'The page changed; fetch it again' });
    expect((await savePage({ base_version: 1, through: 1, full_rebuild: false })).status).toBe(200);
  });

  it('a digest saved after the inputs were read keeps the project in pages_needed', async () => {
    await withDigest('a', '2026-10-01T00:00:00.000Z');
    const read = await inputs();
    await withDigest('b', '2026-10-02T00:00:00.000Z');
    expect((await savePage({ through: read.through })).status).toBe(200);
    expect(await needed()).toEqual(['github.com/me/alpha']);
  });

  it('rejects a malformed page with 400, and a read token with 403', async () => {
    await withDigest('a', '2026-10-01T00:00:00.000Z');
    expect((await savePage({ summary: 5 })).status).toBe(400);
    expect((await savePage({ base_version: 'x' })).status).toBe(400);
    expect((await call('GET', `/api/projects/${KEY}/page-inputs`, { token: read })).status).toBe(403);
    expect((await call('PUT', `/api/projects/${KEY}/page`, { token: read, body: '{}' })).status).toBe(403);
  });

  it('deletes a page only when the project has no digests left', async () => {
    await withDigest('a', '2026-10-01T00:00:00.000Z');
    await savePage({ through: 1 });
    expect((await call('DELETE', `/api/projects/${KEY}/page`, { token: ingest })).status).toBe(409);
    db.prepare("UPDATE digests SET status = 'refused', text = NULL").run();
    expect((await call('DELETE', `/api/projects/${KEY}/page`, { token: ingest })).status).toBe(204);
    expect((await inputs()).page).toBeNull();
  });
});
