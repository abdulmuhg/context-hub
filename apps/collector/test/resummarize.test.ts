import { gunzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it } from 'vitest';
import type { StateRequest } from '@context-hub/core';
import { FakeLlm } from '../../../packages/core/test/fake-llm.js';
import { UsageLimitError } from '../src/claude-llm.js';
import { loadConfig, saveConfig, saveToken } from '../src/config.js';
import { runResummarize } from '../src/resummarize.js';
import { tempDir } from './helpers.js';

const KEY = 'github.com/me/alpha';
const OTHER = 'github.com/me/beta';
const HASH = (n: number) => String(n).padStart(64, '0');

interface Entry {
  source: string;
  id: string;
  content_hash: string;
  last_activity_at: string | null;
  status: 'pending' | 'ok' | 'failed' | 'refused' | null;
  model: string | null;
  written_by: string | null;
  summary_to_follow: boolean;
}

let hub: string;
let llm: FakeLlm;
let lists: Record<string, Entry[]>;
let digestPuts: { url: string; body: any }[];
let pagePuts: { key: string; body: any }[];
let digestAnswer: number;

const entry = (id: string, over: Partial<Entry> = {}): Entry => ({
  source: 'claude-code',
  id,
  content_hash: HASH(Number(id.replace(/\D/g, '')) || 1),
  last_activity_at: `2026-10-${String(Number(id.replace(/\D/g, '')) || 1).padStart(2, '0')}T10:00:00.000Z`,
  status: 'ok',
  model: 'claude-haiku-5-5',
  written_by: null,
  summary_to_follow: false,
  ...over,
});

const fetchImpl: typeof fetch = async (input, init) => {
  const url = String(input);
  const method = init?.method ?? 'GET';
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
  const project = url.includes('/api/projects/') ? decodeURIComponent(url.split('/api/projects/')[1]!.split('/')[0]!) : '';
  if (method === 'GET' && url.endsWith('/digests')) return lists[project] ? json({ sessions: lists[project] }) : new Response('{}', { status: 404 });
  if (method === 'GET' && url.includes('/api/sessions/')) {
    const [source, id] = url.split('/api/sessions/')[1]!.split('/').map(decodeURIComponent);
    const found = Object.values(lists).flat().find((e) => e.source === source && e.id === id);
    return json({
      session: { source, source_session_id: id, project_key: KEY, parent: null, title: `T-${id}`, content_hash: found?.content_hash, messages: [{ seq: 0, role: 'user', kind: 'text', ts: null, text: `hello ${id}` }] },
    });
  }
  if (method === 'PUT' && url.endsWith('/digest')) {
    digestPuts.push({ url, body: JSON.parse(gunzipSync(init!.body as Uint8Array).toString('utf8')) });
    return new Response(digestAnswer === 204 ? null : '{}', { status: digestAnswer });
  }
  if (method === 'GET' && url.endsWith('/page-inputs')) {
    return json({ page: { summary: 's', body: 'old', version: 4, rebuilt_at: '2026-10-20T00:00:00.000Z', dirty: false, digests_through: 9 }, digests: [{ session_id: 'claude-code:x', title: 't', date: null, text: 'Goal: x', saved_seq: 5 }], through: 9 });
  }
  if (method === 'PUT' && url.endsWith('/page')) {
    pagePuts.push({ key: project, body: JSON.parse(gunzipSync(init!.body as Uint8Array).toString('utf8')) });
    return json({ version: 5 });
  }
  return new Response('{}', { status: 404 });
};

const run = (over: Partial<Parameters<typeof runResummarize>[0]> = {}) =>
  runResummarize({ hubDir: hub, fetchImpl, llm, now: () => new Date('2026-10-21T10:00:00Z'), ...over });
const stateCalls = () => llm.calls.filter((c) => c.kind === 'state').map((c) => c.req as StateRequest);
const rewrittenIds = () => digestPuts.map((p) => p.url.split('/api/sessions/claude-code/')[1]!.split('/')[0]);

beforeEach(() => {
  hub = tempDir();
  saveConfig(hub, { ...loadConfig(hub), server_url: 'https://hub.example.com', tracked: [KEY, OTHER] });
  saveToken(hub, 'tok');
  llm = new FakeLlm();
  lists = { [KEY]: [], [OTHER]: [] };
  digestPuts = [];
  pagePuts = [];
  digestAnswer = 204;
});

describe('runResummarize', () => {
  it('rewrites server-written digests and leaves notes alone', async () => {
    lists[KEY] = [entry('s1'), entry('s2', { status: 'pending', model: null }), entry('n1', { source: 'note', model: 'note' })];
    const out = await run();
    expect(rewrittenIds().sort()).toEqual(['s1', 's2']);
    expect(out.rewritten).toEqual([
      { project: KEY, session: 'claude-code:s2' },
      { project: KEY, session: 'claude-code:s1' },
    ]);
    expect(digestPuts[0]!.body).toMatchObject({ hash: HASH(2), digest: { model: 'fake-model', body: { goal: expect.stringContaining('digest of T-s2') } } });
  });

  it('rewrites pending, failed and refused digests whoever wrote them', async () => {
    lists[KEY] = [
      entry('s1', { written_by: 'my-pc', model: 'claude-sonnet-5-5', status: 'failed' }),
      entry('s2', { written_by: 'my-pc', model: 'claude-sonnet-5-5', status: 'refused' }),
      entry('s3', { written_by: 'my-pc', model: 'claude-sonnet-5-5', status: 'pending' }),
      entry('s4', { written_by: 'my-pc', model: 'claude-sonnet-5-5', status: 'ok' }),
    ];
    await run();
    expect(rewrittenIds().sort()).toEqual(['s1', 's2', 's3']);
  });

  it('leaves computer-written digests unless --model-not names another model', async () => {
    lists[KEY] = [entry('s1', { written_by: 'my-pc', model: 'claude-sonnet-5-5' }), entry('s2', { written_by: 'other-pc', model: 'claude-opus-5-5' })];
    await run();
    expect(digestPuts).toEqual([]);
    await run({ modelNot: 'claude-sonnet-5-5' });
    expect(rewrittenIds()).toEqual(['s2']);
  });

  it('respects the cap and --all', async () => {
    lists[KEY] = Array.from({ length: 22 }, (_, i) => entry(`s${i + 1}`));
    const capped = await run();
    expect(capped.rewritten).toHaveLength(20);
    expect(capped.waiting).toEqual({ count: 2, reason: 'cap of 20 reached. Run hub resummarize --all to catch up' });
    expect(rewrittenIds()[0]).toBe('s22'); // newest first
    digestPuts = [];
    const all = await run({ all: true });
    expect(all.rewritten).toHaveLength(22);
    expect(all.waiting.count).toBe(0);
  });

  it('fully rebuilds the touched pages', async () => {
    lists[KEY] = [entry('s1')];
    const out = await run();
    expect(out.pages).toEqual({ updated: [KEY], left: [], checked: [] });
    expect(stateCalls()[0]!.mode).toBe('rebuild');
    expect(pagePuts).toHaveLength(1);
    expect(pagePuts[0]!.body).toMatchObject({ base_version: 4, full_rebuild: true });
  });

  it('leaves a project alone when none of its digests qualify', async () => {
    lists[KEY] = [entry('s1', { written_by: 'my-pc', model: 'claude-sonnet-5-5' })];
    const out = await run();
    expect(out.pages).toEqual({ updated: [], left: [], checked: [] });
    expect(llm.calls).toEqual([]);
  });

  it('skips a session that moved since it was listed', async () => {
    lists[KEY] = [entry('s1')];
    digestAnswer = 409;
    const out = await run();
    expect(out.rewritten).toEqual([]);
    expect(out.waiting.count).toBe(1);
    expect(pagePuts).toEqual([]);
  });

  it('narrows to one project', async () => {
    lists[KEY] = [entry('s1')];
    lists[OTHER] = [entry('s2')];
    await run({ project: 'beta' });
    expect(rewrittenIds()).toEqual(['s2']);
  });

  it('refuses a project that is not tracked', async () => {
    await expect(run({ project: 'gamma' })).rejects.toThrow(/not tracked/);
  });

  it('fails clearly when Claude Code is not installed', async () => {
    await expect(run({ llm: null })).rejects.toThrow('Claude Code is not installed, so sessions wait here. Install it, then run: claude');
  });

  it('stops at the usage limit and says so', async () => {
    lists[KEY] = [entry('s1'), entry('s2')];
    llm.digest = async () => {
      throw new UsageLimitError(null);
    };
    const out = await run();
    expect(out.rewritten).toEqual([]);
    expect(out.waiting).toEqual({ count: 2, reason: 'Claude usage limit reached' });
    expect(digestPuts).toEqual([]);
  });
});
