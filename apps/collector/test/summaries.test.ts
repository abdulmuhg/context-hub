import { gunzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it } from 'vitest';
import type { StateRequest } from '@context-hub/core';
import { FakeLlm } from '../../../packages/core/test/fake-llm.js';
import { UsageLimitError } from '../src/claude-llm.js';
import { newBudget, stopReason, updatePages } from '../src/summaries.js';
import type { Remote } from '../src/upload.js';

const KEY = 'github.com/me/alpha';
const NOW = '2026-10-20T12:00:00.000Z';

const digest = (id: string, seq: number) => ({ session_id: `claude-code:${id}`, title: `T-${id}`, date: `2026-10-0${seq}T00:00:00.000Z`, text: `Goal: ${id}`, saved_seq: seq });

interface Page {
  summary: string;
  body: string;
  version: number;
  rebuilt_at: string;
  dirty: boolean;
  digests_through: number;
}

let llm: FakeLlm;
let inputs: Record<string, { page: Page | null; digests: ReturnType<typeof digest>[]; through: number }>;
let puts: { key: string; body: any }[];
let deletes: string[];
let putAnswer: number;
let remote: Remote;

const fetchImpl: typeof fetch = async (input, init) => {
  const url = String(input);
  const method = init?.method ?? 'GET';
  const key = decodeURIComponent(url.split('/api/projects/')[1]!.split('/')[0]!);
  if (url.endsWith('/page-inputs')) return new Response(JSON.stringify(inputs[key]), { status: 200 });
  if (url.endsWith('/page') && method === 'PUT') {
    puts.push({ key, body: JSON.parse(gunzipSync(init!.body as Uint8Array).toString('utf8')) });
    return new Response(putAnswer === 200 ? '{"version":2}' : '{"error":"The page changed; fetch it again"}', { status: putAnswer });
  }
  if (url.endsWith('/page') && method === 'DELETE') {
    deletes.push(key);
    return new Response(null, { status: 204 });
  }
  return new Response('{}', { status: 404 });
};

const page = (over: Partial<Page> = {}): Page => ({ summary: 's', body: 'old body', version: 3, rebuilt_at: NOW, dirty: false, digests_through: 1, ...over });
const stateCalls = () => llm.calls.filter((c) => c.kind === 'state').map((c) => c.req as StateRequest);
const run = (keys: string[], budget = newBudget(false), over: { forceRebuild?: boolean } = {}) =>
  updatePages(remote, llm, keys, budget, { now: NOW, maxChars: 100_000, ...over });

beforeEach(() => {
  llm = new FakeLlm();
  inputs = { [KEY]: { page: page(), digests: [digest('a', 1), digest('b', 2)], through: 2 } };
  puts = [];
  deletes = [];
  putAnswer = 200;
  remote = { url: 'https://hub.example.com', token: 't', fetchImpl };
});

describe('updatePages', () => {
  it('merges only digests newer than the page', async () => {
    const out = await run([KEY]);
    expect(out).toEqual({ updated: [KEY], left: [] });
    const req = stateCalls()[0]!;
    expect(req.mode).toBe('merge');
    expect(req.digests.map((d) => d.session_id)).toEqual(['claude-code:b']);
    expect(req.previous).toBe('old body');
    expect(puts[0]!.body).toMatchObject({ base_version: 3, through: 2, full_rebuild: false, model: 'fake-model' });
    expect(puts[0]!.key).toBe(KEY);
  });

  it('rebuilds a dirty page from every digest', async () => {
    inputs[KEY]!.page = page({ dirty: true });
    await run([KEY]);
    const req = stateCalls()[0]!;
    expect(req.mode).toBe('rebuild');
    expect(req.digests.map((d) => d.session_id)).toEqual(['claude-code:a', 'claude-code:b']);
    expect(puts[0]!.body.full_rebuild).toBe(true);
  });

  it('writes a first page with no base version', async () => {
    inputs[KEY]!.page = null;
    await run([KEY]);
    expect(puts[0]!.body).toMatchObject({ base_version: null, full_rebuild: true });
  });

  it('rebuilds when forced', async () => {
    await run([KEY], newBudget(false), { forceRebuild: true });
    expect(stateCalls()[0]!.mode).toBe('rebuild');
  });

  it('retries a refused page save twice, then leaves it', async () => {
    putAnswer = 409;
    const out = await run([KEY]);
    expect(puts).toHaveLength(3);
    expect(out).toEqual({ updated: [], left: [KEY] });
  });

  it('starts again from fresh inputs after a refused save', async () => {
    let reads = 0;
    const real = fetchImpl;
    remote = {
      ...remote,
      fetchImpl: async (input, init) => {
        if (String(input).endsWith('/page-inputs')) reads++;
        if (String(input).endsWith('/page') && init?.method === 'PUT' && puts.length === 0) {
          puts.push({ key: KEY, body: {} });
          return new Response('{}', { status: 409 });
        }
        return real(input, init);
      },
    };
    const out = await run([KEY]);
    expect(reads).toBe(2);
    expect(out.updated).toEqual([KEY]);
  });

  it('deletes the page when the project has no digests', async () => {
    inputs[KEY] = { page: page(), digests: [], through: 0 };
    const out = await run([KEY]);
    expect(deletes).toEqual([KEY]);
    expect(out.updated).toEqual([KEY]);
    expect(llm.calls).toEqual([]);
  });

  it('skips pages once the usage limit is hit', async () => {
    inputs['github.com/me/beta'] = { page: page(), digests: [digest('c', 2)], through: 2 };
    llm.projectState = async () => {
      throw new UsageLimitError('2026-10-20T14:00:00.000Z');
    };
    const budget = newBudget(false);
    const out = await run([KEY, 'github.com/me/beta'], budget);
    expect(out).toEqual({ updated: [], left: [KEY, 'github.com/me/beta'] });
    expect(budget.stopped).toMatch(/usage limit/);
    expect(puts).toEqual([]);
  });

  it('makes no call at all when the run is already stopped', async () => {
    const budget = newBudget(false);
    budget.stopped = 'Claude usage limit reached';
    const out = await run([KEY], budget);
    expect(out).toEqual({ updated: [], left: [KEY] });
    expect(llm.calls).toEqual([]);
  });

  it('leaves a page whose inputs cannot be read and goes on to the next', async () => {
    inputs['github.com/me/beta'] = { page: page(), digests: [digest('c', 2)], through: 2 };
    delete inputs[KEY];
    const out = await run([KEY, 'github.com/me/beta']);
    expect(out).toEqual({ updated: ['github.com/me/beta'], left: [KEY] });
  });

  it('does not count toward the summary cap', async () => {
    const budget = newBudget(false);
    await run([KEY], budget);
    expect(budget.left).toBe(20);
  });
});

describe('stopReason', () => {
  it('shows the reset time as Claude Code wrote it when it is not a timestamp', () => {
    expect(stopReason(new UsageLimitError(null, '5:20pm (Asia/Jakarta)'))).toBe('Claude usage limit reached (resets 5:20pm (Asia/Jakarta))');
  });

  it('says only that the limit was reached when there is no reset time', () => {
    expect(stopReason(new UsageLimitError(null))).toBe('Claude usage limit reached');
  });
});
