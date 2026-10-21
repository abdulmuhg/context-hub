import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadConfig, saveConfig, savePersonal, saveToken } from '@context-hub/collector/config';
import { runSync } from '@context-hub/collector/sync';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db.js';
import { handleMcp } from '../src/mcp.js';
import { createToken } from '../src/tokens.js';
import { FakeLlm, startServer } from './helpers.js';

const SID = '11111111-1111-4111-8111-111111111111';
const SECRET = 'gh' + 'p_' + 'a'.repeat(36);
const CARD = '4242424242424242';
const NOW = '2026-10-11T00:00:00.000Z';

let db: Db;
let url: string;
let close: () => Promise<void>;
let home: string;
let hub: string;
let readToken: string;

const temp = () => mkdtempSync(join(tmpdir(), 'hub-e2e-'));

function writeJsonl(path: string, records: unknown[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

const rec = (type: 'user' | 'assistant', content: unknown, cwd: string) => ({
  type,
  sessionId: SID,
  cwd,
  gitBranch: 'main',
  ownerAccountUuid: 'acct-1',
  timestamp: '2026-10-05T10:00:00.000Z',
  message: { role: type, content },
});

const sync = (over = {}) =>
  runSync({
    home,
    hubDir: hub,
    exists: () => true,
    llm: new FakeLlm(),
    git: (cwd, args) => (cwd.includes('alpha') ? (args[0] === 'remote' ? 'git@github.com:me/alpha.git' : '/work/alpha') : null),
    ...over,
  });

beforeEach(async () => {
  db = openDb(':memory:');
  ({ url, close } = await startServer({ db, mcp: handleMcp(db), log: () => {} }));
  readToken = createToken(db, 'assistant', 'read', NOW).token;
  home = temp();
  hub = temp();
  saveConfig(hub, { ...loadConfig(hub), server_url: url, tracked: ['github.com/me/alpha'], personal: { card: 'full', list: 'full' } });
  saveToken(hub, createToken(db, 'collector', 'ingest', NOW).token);
  savePersonal(hub, [{ label: 'phone', value: '0812-3456-7890' }]);

  const projects = join(home, '.claude', 'projects');
  writeJsonl(join(projects, 'alpha', `${SID}.jsonl`), [
    rec('user', `the deploy fails, token is ${SECRET}, card ${CARD}, call 0812 3456 7890`, '/work/alpha'),
    rec('assistant', [{ type: 'text', text: 'We decided to drop the staging cache.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pnpm deploy' } }], '/work/alpha'),
    rec('user', [{ type: 'tool_result', tool_use_id: 't1', content: 'deployed' }], '/work/alpha'),
  ]);
  writeJsonl(join(projects, 'private', '22222222-2222-4222-8222-222222222222.jsonl'), [rec('user', 'untracked diary entry', '/tmp/private')]);
});

afterEach(async () => {
  await close();
});

describe('collector to server to assistant', () => {
  it('uploads a tracked session and an assistant can read it back through the lookup tools', async () => {
    const report = await sync();
    expect(report.errors).toEqual([]);
    expect(report.uploaded).toEqual([{ project: 'github.com/me/alpha', session: `claude-code:${SID}` }]);

    const client = new Client({ name: 'e2e', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${readToken}` } } }));
    const call = async (name: string, args: Record<string, unknown> = {}) =>
      JSON.parse(((await client.callTool({ name, arguments: args })) as { content: { text: string }[] }).content[0]!.text);

    expect((await call('list_projects')).projects.map((p: any) => p.key)).toEqual(['github.com/me/alpha']);
    const project = await call('get_project', { project: 'alpha' });
    expect(project.recent[0].session_id).toBe(`claude-code:${SID}`);
    const hits = (await call('search', { query: 'staging cache' })).hits;
    expect(hits[0]).toMatchObject({ session_id: `claude-code:${SID}`, kind: 'message' });
    const session = await call('get_session', { session_id: hits[0].session_id });
    expect(session.messages.map((m: any) => m.kind)).toEqual(['text', 'text', 'tool_call']);
    expect(session.messages[2]).toMatchObject({ tool_name: 'Bash', tool_result: 'deployed' });
    await client.close();
  });

  it('leaves no secret, card number or listed personal value anywhere in the database', async () => {
    await sync();
    const dump = JSON.stringify(
      ['projects', 'sessions', 'messages', 'search_index'].map((t) => db.prepare(`SELECT * FROM ${t}`).all()),
    );
    expect(dump).toContain('[REDACTED:github]');
    expect(dump).not.toContain(SECRET);
    expect(dump).not.toContain(CARD);
    expect(dump).not.toMatch(/0812[\s-]?3456[\s-]?7890/);
  });

  it('stores nothing from a project that is not tracked', async () => {
    await sync();
    const dump = JSON.stringify(['projects', 'sessions', 'messages', 'search_index'].map((t) => db.prepare(`SELECT * FROM ${t}`).all()));
    expect(dump).not.toContain('diary');
    expect(db.prepare('SELECT COUNT(*) AS n FROM projects').get()).toEqual({ n: 1 });
  });

  it('a second sync changes nothing on the server', async () => {
    await sync();
    const before = db.prepare('SELECT synced_at FROM sessions').all();
    const second = await sync();
    expect(second.uploaded).toEqual([]);
    expect(db.prepare('SELECT synced_at FROM sessions').all()).toEqual(before);
  });

  it('a revoked upload token stops the sync with a clear error', async () => {
    db.prepare("UPDATE tokens SET revoked_at = ? WHERE scope = 'ingest'").run(NOW);
    const report = await sync();
    expect(report.uploaded).toEqual([]);
    expect(report.errors[0]).toMatch(/401/);
  });
});
