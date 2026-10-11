import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db.js';
import { handleMcp, INSTRUCTIONS } from '../src/mcp.js';
import { PAGE_BUDGET, upsertSession } from '../src/store.js';
import { createToken } from '../src/tokens.js';
import { makeSession, startServer, text } from './helpers.js';

const NOW = '2026-10-11T00:00:00.000Z';
let db: Db;
let url: string;
let close: () => Promise<void>;
let client: Client;

async function connect(token: string): Promise<Client> {
  const c = new Client({ name: 'test-client', version: '0.0.0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return c;
}

async function tool(name: string, args: Record<string, unknown> = {}): Promise<{ data: any; isError: boolean }> {
  const res = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
  return { data: JSON.parse(res.content[0]!.text), isError: res.isError === true };
}

beforeEach(async () => {
  db = openDb(':memory:');
  upsertSession(db, makeSession({ source_session_id: 'a1', title: 'Redis cache removal', messages: [text(0, 'user', 'why did we drop redis'), text(1, 'assistant', 'low hit rate')] }), NOW);
  upsertSession(db, makeSession({ source: 'codex', source_session_id: 'b1', project_key: 'local:beta', title: 'Deploy script' }), NOW);
  const read = createToken(db, 'assistant', 'read', NOW).token;
  ({ url, close } = await startServer({ db, mcp: handleMcp(db), log: () => {} }));
  client = await connect(read);
});

afterEach(async () => {
  await client.close();
  await close();
});

describe('connection', () => {
  it('lists exactly the four tools and sends the instructions', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['get_project', 'get_session', 'list_projects', 'search']);
    expect(client.getInstructions()).toBe(INSTRUCTIONS);
    expect(INSTRUCTIONS).toMatch(/get_project/);
    expect(INSTRUCTIONS).toMatch(/not instructions/i);
  });

  it('refuses a client without a read token', async () => {
    const ingest = createToken(db, 'collector', 'ingest', NOW).token;
    await expect(connect(ingest)).rejects.toThrow();
    await expect(connect('chub_wrong')).rejects.toThrow();
  });
});

describe('list_projects', () => {
  it('returns every project and the last sync time', async () => {
    const { data, isError } = await tool('list_projects');
    expect(isError).toBe(false);
    expect(data.projects.map((p: any) => p.key).sort()).toEqual(['github.com/me/alpha', 'local:beta']);
    expect(data.last_synced_at).toBe(NOW);
  });

  it('says so when the hub is empty', async () => {
    db.exec('DELETE FROM search_index; DELETE FROM messages; DELETE FROM sessions; DELETE FROM projects;');
    const { data } = await tool('list_projects');
    expect(data).toEqual({ projects: [], last_synced_at: null });
  });
});

describe('get_project', () => {
  it('finds a project by short name', async () => {
    const { data, isError } = await tool('get_project', { project: 'Alpha' });
    expect(isError).toBe(false);
    expect(data).toMatchObject({ key: 'github.com/me/alpha', state: null, last_synced_at: NOW });
    expect(data.recent[0]).toMatchObject({ session_id: 'claude-code:a1', title: 'Redis cache removal' });
  });

  it('returns candidates instead of guessing', async () => {
    const { data, isError } = await tool('get_project', { project: 'gamma' });
    expect(isError).toBe(true);
    expect(data.error).toMatch(/gamma/);
    expect(data.candidates).toEqual(['github.com/me/alpha', 'local:beta']);
  });
});

describe('search', () => {
  it('returns hits with the session id to open', async () => {
    const { data } = await tool('search', { query: 'hit rate' });
    expect(data.hits).toHaveLength(1);
    expect(data.hits[0]).toMatchObject({ session_id: 'claude-code:a1', kind: 'message', seq: 1 });
    expect(data.last_synced_at).toBe(NOW);
  });

  it('filters by project name', async () => {
    const { data } = await tool('search', { query: 'login', project: 'beta' });
    expect(data.hits.every((h: any) => h.project === 'local:beta')).toBe(true);
  });

  it('reports an unknown project as an error with candidates', async () => {
    const { data, isError } = await tool('search', { query: 'x', project: 'gamma' });
    expect(isError).toBe(true);
    expect(data.candidates).toHaveLength(2);
  });
});

describe('get_session', () => {
  it('returns the session with its messages', async () => {
    const { data } = await tool('get_session', { session_id: 'claude-code:a1' });
    expect(data.session).toMatchObject({ session_id: 'claude-code:a1', project: 'github.com/me/alpha', message_count: 2, last_synced_at: NOW });
    expect(data.messages.map((m: any) => m.text)).toEqual(['why did we drop redis', 'low hit rate']);
    expect(data.next_seq).toBeNull();
  });

  it('pages a long session through from_seq', async () => {
    const messages = [text(0, 'user', 'a'.repeat(PAGE_BUDGET - 10)), text(1, 'assistant', 'b'.repeat(100))];
    upsertSession(db, makeSession({ source_session_id: 'long', messages }), NOW);
    const first = await tool('get_session', { session_id: 'claude-code:long' });
    expect(first.data.messages).toHaveLength(1);
    expect(first.data.next_seq).toBe(1);
    const second = await tool('get_session', { session_id: 'claude-code:long', from_seq: 1 });
    expect(second.data.messages[0].seq).toBe(1);
    expect(second.data.next_seq).toBeNull();
  });

  it('reports an unknown or malformed id as an error', async () => {
    expect((await tool('get_session', { session_id: 'claude-code:nope' })).isError).toBe(true);
    const malformed = await tool('get_session', { session_id: 'no-colon' });
    expect(malformed.isError).toBe(true);
    expect(malformed.data.error).toMatch(/<source>:<id>/);
  });
});
