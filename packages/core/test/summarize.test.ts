import { describe, expect, it } from 'vitest';
import { buildStatePage, EMPTY_DIGEST, REBUILD_AFTER_MS, writeDigest, type PageDigest, type PageInputs, type StateRequest } from '../src/index.js';
import { FakeLlm, text } from './fake-llm.js';

const NOW = '2026-10-20T12:00:00.000Z';

const digest = (id: string, day: number): PageDigest => ({ session_id: id, title: `t-${id}`, date: `2026-10-${10 + day}T10:00:00.000Z`, text: `Goal: ${id}` });

const inputs = (over: Partial<PageInputs> = {}): PageInputs => {
  const digests = [digest('a', 0), digest('b', 1)];
  return {
    project: 'github.com/me/alpha',
    page: { summary: 's', body: 'old body', rebuilt_at: NOW, dirty: false },
    digests,
    fresh: [digests[1]!],
    now: NOW,
    maxChars: 100_000,
    ...over,
  };
};

const stateReq = (llm: FakeLlm): StateRequest => llm.calls.find((c) => c.kind === 'state')!.req as StateRequest;

describe('writeDigest', () => {
  it('returns EMPTY_DIGEST without a call for an empty session', async () => {
    const llm = new FakeLlm();
    expect(await writeDigest(llm, { project: 'p', title: 't', messages: [] }, 1000)).toEqual(EMPTY_DIGEST);
    expect(llm.calls.length).toBe(0);
  });

  it('splits above maxChars and merges the parts', async () => {
    const llm = new FakeLlm();
    const messages = [text(0, 'user', 'a'.repeat(100)), text(1, 'assistant', 'b'.repeat(100))];
    await writeDigest(llm, { project: 'p', title: 't', messages }, 150);
    expect(llm.calls.map((c) => c.kind)).toEqual(['digest', 'digest', 'merge']);
  });

  it('makes one call for a session that fits', async () => {
    const llm = new FakeLlm();
    await writeDigest(llm, { project: 'p', title: 't', messages: [text(0, 'user', 'hi')] }, 1000);
    expect(llm.calls.map((c) => c.kind)).toEqual(['digest']);
  });
});

describe('buildStatePage', () => {
  it('rebuilds when there is no page', async () => {
    const llm = new FakeLlm();
    const out = await buildStatePage(llm, inputs({ page: null }));
    expect(out?.fullRebuild).toBe(true);
    expect(stateReq(llm).mode).toBe('rebuild');
  });

  it('merges only fresh digests into a current page', async () => {
    const llm = new FakeLlm();
    const i = inputs();
    const out = await buildStatePage(llm, i);
    expect(out?.fullRebuild).toBe(false);
    const req = stateReq(llm);
    expect(req.mode).toBe('merge');
    expect(req.digests).toEqual(i.fresh);
    expect(req.previous).toBe('old body');
  });

  it('rebuilds a dirty page', async () => {
    const llm = new FakeLlm();
    const out = await buildStatePage(llm, inputs({ page: { summary: 's', body: 'b', rebuilt_at: NOW, dirty: true } }));
    expect(out?.fullRebuild).toBe(true);
    expect(stateReq(llm).mode).toBe('rebuild');
  });

  it('rebuilds a page older than 7 days', async () => {
    const llm = new FakeLlm();
    const rebuilt = new Date(Date.parse(NOW) - REBUILD_AFTER_MS - 1000).toISOString();
    const out = await buildStatePage(llm, inputs({ page: { summary: 's', body: 'b', rebuilt_at: rebuilt, dirty: false } }));
    expect(out?.fullRebuild).toBe(true);
  });

  it('rebuilds when forced', async () => {
    const llm = new FakeLlm();
    const out = await buildStatePage(llm, inputs({ forceRebuild: true }));
    expect(out?.fullRebuild).toBe(true);
  });

  it('returns null when there are no digests', async () => {
    const llm = new FakeLlm();
    expect(await buildStatePage(llm, inputs({ digests: [], fresh: [] }))).toBeNull();
    expect(llm.calls.length).toBe(0);
  });

  it('keeps the page when the review throws', async () => {
    const llm = new FakeLlm();
    llm.nextReview = new Error('boom');
    const out = await buildStatePage(llm, inputs({ page: null }));
    expect(out?.page.body).toContain('mode=rebuild');
  });

  it('uses the previous page when the digests do not all fit', async () => {
    const llm = new FakeLlm();
    await buildStatePage(llm, inputs({ forceRebuild: true, maxChars: 10 }));
    const req = stateReq(llm);
    expect(req.digests.map((d) => d.session_id)).toEqual(['b']);
    expect(req.previous).toBe('old body');
  });
});
