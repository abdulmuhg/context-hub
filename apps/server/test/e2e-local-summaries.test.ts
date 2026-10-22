import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db.js';
import { handleMcp } from '../src/mcp.js';
import { createToken } from '../src/tokens.js';
import { startServer } from './helpers.js';
import { ClaudeCodeLlm, type ClaudeRunner } from '../../collector/src/claude-llm.js';
import { loadConfig, saveConfig, saveToken } from '../../collector/src/config.js';
import { runSync } from '../../collector/src/sync.js';
import { getPageInputs, putPage } from '../../collector/src/upload.js';

const SID = '11111111-1111-4111-8111-111111111111';
const SID2 = '22222222-2222-4222-8222-222222222222';
const KEY = 'github.com/me/alpha';
const NOW = '2026-10-11T00:00:00.000Z';

let db: Db;
let url: string;
let close: () => Promise<void>;
let home: string;
let hub: string;
let token: string;
let headerNames: string[];
let runnerEnvs: NodeJS.ProcessEnv[];
let runs: number;

const temp = () => mkdtempSync(join(tmpdir(), 'hub-e2e-local-'));

function writeJsonl(path: string, records: unknown[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

const rec = (sid: string, text: string, ts: string) => ({ type: 'user', sessionId: sid, cwd: '/work/alpha', gitBranch: 'main', timestamp: ts, message: { role: 'user', content: text } });

/** Stands in for `claude -p`: answers each request with an object in the shape of the schema it was given. */
const fakeClaude: ClaudeRunner = async (_cmd, args, _stdin, env) => {
  runs++;
  runnerEnvs.push(env);
  const props = Object.keys((JSON.parse(args[args.indexOf('--json-schema') + 1]!) as { properties: Record<string, unknown> }).properties);
  const structured = props.includes('drop_open')
    ? { drop_open: [], drop_current: [], summary: '' }
    : props.includes('body') && props.includes('summary')
      ? { summary: 'Alpha: the staging deploy is being fixed.', body: '## What this is\n\nA deploy tool.\n\n## Current state\n\n- Staging cache dropped.\n\n## Open items\n\n- none' }
      : { goal: 'Fix the staging deploy after the zebrafish rollback', done: [{ text: 'dropped the staging cache', seq: 0 }], decisions: [], open_items: [], key_refs: [] };
  return { status: 0, stdout: JSON.stringify({ type: 'result', is_error: false, structured_output: structured }), stderr: '', timedOut: false };
};

const sync = (over = {}) =>
  runSync({
    home,
    hubDir: hub,
    exists: () => true,
    git: (cwd, args) => (cwd.includes('alpha') ? (args[0] === 'remote' ? 'git@github.com:me/alpha.git' : '/work/alpha') : null),
    llm: new ClaudeCodeLlm({ model: 'claude-sonnet-5-5', effort: 'low', cmd: 'claude', run: fakeClaude }),
    fetchImpl: async (input, init) => {
      for (const name of Object.keys((init?.headers ?? {}) as Record<string, string>)) headerNames.push(name);
      return fetch(input, init);
    },
    ...over,
  });

beforeEach(async () => {
  headerNames = [];
  runnerEnvs = [];
  runs = 0;
  db = openDb(':memory:');
  // No key, no worker: the server only stores, searches and serves.
  ({ url, close } = await startServer({ db, mcp: handleMcp(db), log: () => {} }));
  home = temp();
  hub = temp();
  token = createToken(db, 'my-pc', 'ingest', NOW).token;
  saveConfig(hub, { ...loadConfig(hub), server_url: url, tracked: [KEY] });
  saveToken(hub, token);
  writeJsonl(join(home, '.claude', 'projects', 'alpha', `${SID}.jsonl`), [rec(SID, 'the staging deploy fails', '2026-10-05T10:00:00.000Z')]);
  process.env.ANTHROPIC_API_KEY = 'sk-ant-not-for-the-hub';
  process.env.ANTHROPIC_AUTH_TOKEN = 'host-token';
});

afterEach(async () => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  await close();
});

describe('local summaries, end to end', () => {
  it('stores a session with its digest, and a page the computer wrote, on a server with no model key', async () => {
    const report = await sync();
    expect(report.errors).toEqual([]);
    expect(report.summarized).toEqual([{ project: KEY, session: `claude-code:${SID}` }]);
    expect(report.pages).toEqual({ updated: [KEY], left: [] });

    const readToken = createToken(db, 'assistant', 'read', NOW).token;
    const client = new Client({ name: 'e2e', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${readToken}` } } }));
    const call = async (name: string, args: Record<string, unknown> = {}) =>
      JSON.parse(((await client.callTool({ name, arguments: args })) as { content: { text: string }[] }).content[0]!.text);

    const hits = (await call('search', { query: 'zebrafish' })).hits;
    expect(hits.some((h: any) => h.kind === 'digest' && h.session_id === `claude-code:${SID}`)).toBe(true);

    const project = await call('get_project', { project: 'alpha' });
    expect(project.state.summary).toBe('Alpha: the staging deploy is being fixed.');
    expect(project.state.stale).toBe(false);
    expect(project.recent[0].digest.goal).toContain('zebrafish rollback');
    expect(project.recent[0].digest.model).toBe('claude-sonnet-5-5');
    await client.close();

    expect(db.prepare('SELECT written_by FROM project_states').get()).toEqual({ written_by: 'my-pc' });
    expect(db.prepare('SELECT written_by, model FROM digests').get()).toEqual({ written_by: 'my-pc', model: 'claude-sonnet-5-5' });
  });

  it('a second computer with a stale page version is refused, then succeeds on a fresh read', async () => {
    await sync();
    const second = { url, token: createToken(db, 'other-pc', 'ingest', NOW).token };
    const seen = await getPageInputs(second, KEY);
    expect(seen.page).not.toBeNull();

    // The first computer updates the page while the second is still working from what it read.
    writeJsonl(join(home, '.claude', 'projects', 'alpha', `${SID2}.jsonl`), [rec(SID2, 'now the cache is back', '2026-10-06T10:00:00.000Z')]);
    await sync();

    const page = { summary: 'Written by the other computer', body: '## What this is\n\nx', model: 'claude-sonnet-5-5', through: seen.through, full_rebuild: false };
    expect(await putPage(second, KEY, { ...page, base_version: seen.page!.version })).toEqual({ ok: false });
    const fresh = await getPageInputs(second, KEY);
    expect(fresh.page!.version).toBeGreaterThan(seen.page!.version);
    expect(await putPage(second, KEY, { ...page, through: fresh.through, base_version: fresh.page!.version })).toMatchObject({ ok: true });
    expect(db.prepare('SELECT written_by, summary FROM project_states').get()).toEqual({ written_by: 'other-pc', summary: 'Written by the other computer' });
  });

  it('sends no ANTHROPIC_ header, starts claude with a clean environment, and the server makes no model call', async () => {
    await sync();
    expect(runs).toBeGreaterThan(0);
    expect(headerNames.filter((h) => /^anthropic/i.test(h))).toEqual([]);
    for (const env of runnerEnvs) expect(Object.keys(env).filter((k) => /^(ANTHROPIC_|CLAUDE)/i.test(k))).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM model_usage').get()).toEqual({ n: 0 });
  });

  it('a second sync with nothing new makes no model call and no upload', async () => {
    await sync();
    const before = runs;
    const again = await sync();
    expect(again.uploaded).toEqual([]);
    expect(runs).toBe(before);
  });
});
