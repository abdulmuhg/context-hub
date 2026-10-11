import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { openDb, type Db } from '../src/db.js';
import { MAX_BODY } from '../src/http.js';
import { AuthLimiter } from '../src/ratelimit.js';
import { createToken } from '../src/tokens.js';
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
  ({ url, close } = await startServer({ db, now: () => NOW, limiter: new AuthLimiter(), log: (l) => logs.push(l) }));
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

  it('429 after 10 failed attempts from one address, even with a valid token afterwards', async () => {
    for (let i = 0; i < 10; i++) await call('GET', '/api/status', { token: 'chub_bad', headers: { 'X-Forwarded-For': '9.9.9.9' } });
    const blocked = await call('GET', '/api/status', { token: read, headers: { 'X-Forwarded-For': '9.9.9.9' } });
    expect(blocked.status).toBe(429);
    const other = await call('GET', '/api/status', { token: read, headers: { 'X-Forwarded-For': '8.8.8.8' } });
    expect(other.status).toBe(200);
  });

  it('uses the first address in X-Forwarded-For', async () => {
    for (let i = 0; i < 10; i++) await call('GET', '/api/status', { token: 'chub_bad', headers: { 'X-Forwarded-For': '7.7.7.7, 10.0.0.1' } });
    expect((await call('GET', '/api/status', { token: read, headers: { 'X-Forwarded-For': '7.7.7.7' } })).status).toBe(429);
  });
});

describe('PUT /api/sessions', () => {
  it('stores a session and reports the change', async () => {
    const res = await put();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stored: true, changed: true, server_redactions: 0 });
    expect((await (await call('GET', '/api/status', { token: read })).json()).sessions).toBe(1);
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
