import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db.js';
import { handleMcp, INSTRUCTIONS } from '../src/mcp.js';
import { createToken } from '../src/tokens.js';
import { runOnce } from '../src/worker.js';
import { FakeLlm, gz, makeSession, startServer, text } from './helpers.js';

const NOW = new Date('2026-10-11T00:00:00.000Z');
let db: Db;
let url: string;
let close: () => Promise<void>;
let client: Client;
let ingest: string;
let llm: FakeLlm;

const upload = async (id: string, body: string) => {
  const s = makeSession({ source_session_id: id, title: `Session ${id}`, messages: [text(0, 'user', body)] });
  const res = await fetch(`${url}/api/sessions/${s.source}/${id}`, { method: 'PUT', headers: { Authorization: `Bearer ${ingest}`, 'Content-Encoding': 'gzip' }, body: gz(s) as BodyInit });
  expect(res.status).toBe(200);
};
const call = async (name: string, args: Record<string, unknown> = {}) =>
  JSON.parse(((await client.callTool({ name, arguments: args })) as { content: { text: string }[] }).content[0]!.text);
const drain = async () => {
  for (let i = 0; i < 20; i++) if ((await runOnce({ db, llm, now: () => NOW, log: () => {} })) === 'idle') return;
  throw new Error('worker never went idle');
};

beforeEach(async () => {
  db = openDb(':memory:');
  llm = new FakeLlm();
  ({ url, close } = await startServer({ db, mcp: handleMcp(db), now: () => NOW, log: () => {} }));
  ingest = createToken(db, 'collector', 'ingest', NOW.toISOString()).token;
  const read = createToken(db, 'assistant', 'read', NOW.toISOString()).token;
  client = new Client({ name: 'e2e', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${read}` } } }));
});

afterEach(async () => {
  await client.close();
  await close();
});

describe('upload, digest, catch up', () => {
  // Review Focus 5
  it('before the worker runs, lookups work and say the digest is pending', async () => {
    await upload('s1', 'why is the login looping');
    const project = await call('get_project', { project: 'alpha' });
    expect(project.state).toBeNull();
    expect(project.recent[0]).toMatchObject({ session_id: 'claude-code:s1', digest: null, digest_status: 'pending' });
    expect((await call('search', { query: 'looping' })).hits).toHaveLength(1);
    const status = await (await fetch(`${url}/api/status`, { headers: { Authorization: `Bearer ${ingest}` } })).json();
    expect(status.digests).toEqual({ pending: 1, ok: 0, failed: 0, refused: 0 });
  });

  it('after the worker runs, get_project is the catch-up answer', async () => {
    await upload('s1', 'why is the login looping');
    await upload('s2', 'now deploy it');
    await drain();
    const project = await call('get_project', { project: 'alpha' });
    expect(project.state.summary).toMatch(/alpha/);
    expect(project.state.stale).toBe(false);
    expect(project.recent).toHaveLength(2);
    for (const s of project.recent) {
      expect(s.digest_status).toBe('ok');
      expect(s.digest.text).toMatch(/^Goal: digest of Session s\d/);
      expect(s.digest.stale).toBe(false);
    }
    expect((await call('list_projects')).projects[0].summary).toBe(project.state.summary);
  });

  it('search ranks the digest above the messages of the same session', async () => {
    await upload('s1', 'digest of Session s1 is mentioned here too');
    await drain();
    const hits = (await call('search', { query: '"digest of Session s1"' })).hits;
    expect(hits[0]).toMatchObject({ kind: 'digest', session_id: 'claude-code:s1', seq: null });
    expect(hits.map((h: any) => h.kind)).toContain('message');
  });

  it('a changed session shows its old digest as stale until the worker catches up', async () => {
    await upload('s1', 'first');
    await drain();
    await upload('s1', 'second, with more work');
    const before = (await call('get_session', { session_id: 'claude-code:s1' })).session;
    expect(before).toMatchObject({ digest_status: 'pending', digest: { stale: true } });
    await drain();
    const after = (await call('get_session', { session_id: 'claude-code:s1' })).session;
    expect(after).toMatchObject({ digest_status: 'ok', digest: { stale: false } });
  });

  it('the instructions tell assistants how to treat stale and missing digests', () => {
    expect(INSTRUCTIONS).toMatch(/stale/i);
    expect(INSTRUCTIONS).toMatch(/digest_status/);
  });
});
