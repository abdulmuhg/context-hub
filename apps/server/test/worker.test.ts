import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db.js';
import { getDigest, getProjectState, saveProjectState } from '../src/digest-store.js';
import { LlmRefusal } from '../src/llm.js';
import { saveNote } from '../src/notes.js';
import { search } from '../src/search.js';
import { deleteSession, getProject, resolveProject, upsertSession } from '../src/store.js';
import { CHARS_PER_TOKEN, REBUILD_AFTER_MS, runOnce, startWorker, type WorkerDeps } from '../src/worker.js';
import { FakeLlm, makeSession, text, tool } from './helpers.js';

const T0 = Date.parse('2026-10-11T00:00:00.000Z');
let db: Db;
let llm: FakeLlm;
let clock: number;
let logs: string[];

const deps = (over: Partial<WorkerDeps> = {}): WorkerDeps => ({ db, llm, now: () => new Date(clock), log: (l) => logs.push(l), ...over });
const iso = () => new Date(clock).toISOString();
const rowId = (id: string) => (db.prepare('SELECT id FROM sessions WHERE source_session_id = ?').get(id) as { id: number }).id;
const pid = (name: string) => {
  const r = resolveProject(db, name);
  if (!r.ok) throw new Error(`no project ${name}`);
  return r.id;
};
const add = (id: string, over: Parameters<typeof makeSession>[0] = {}) => upsertSession(db, makeSession({ source_session_id: id, title: `T-${id}`, ...over }), iso());
const drain = async (d = deps()) => {
  const seen: string[] = [];
  for (let i = 0; i < 50; i++) {
    const r = await runOnce(d);
    seen.push(r);
    if (r === 'idle') return seen;
  }
  throw new Error('worker never went idle');
};

beforeEach(() => {
  db = openDb(':memory:');
  llm = new FakeLlm();
  clock = T0;
  logs = [];
});

describe('runOnce: digests', () => {
  it('is idle when there is nothing to do, and calls no model', async () => {
    expect(await runOnce(deps())).toBe('idle');
    expect(llm.calls).toEqual([]);
  });

  it('digests a session, stores the text and makes it searchable', async () => {
    add('a', { messages: [text(0, 'user', 'fix login'), tool(1, 'Bash', 'pnpm test', 'ok')] });
    expect(await runOnce(deps())).toBe('digest');
    const d = getDigest(db, rowId('a'))!;
    expect(d).toMatchObject({ status: 'ok', model: 'fake-model' });
    expect(d.text).toContain('Goal: digest of T-a');
    expect(search(db, { query: '"digest of T-a"' })[0]).toMatchObject({ kind: 'digest', session_id: 'claude-code:a', seq: null });
  });

  it('sends numbered lines, the project and the title to the model', async () => {
    add('a', { messages: [text(0, 'user', 'fix login'), tool(1, 'Bash', 'pnpm test', 'ok')] });
    await runOnce(deps());
    expect(llm.calls[0]).toEqual({
      kind: 'digest',
      req: { project: 'github.com/me/alpha', title: 'T-a', transcript: '[0] USER: fix login\n[1] TOOL Bash(pnpm test) -> ok: ok', part: null },
    });
  });

  it('processes the session with the oldest activity first', async () => {
    add('new', { last_activity_at: '2026-10-05T00:00:00.000Z' });
    add('old', { last_activity_at: '2026-10-01T00:00:00.000Z' });
    await runOnce(deps());
    expect((llm.calls[0]!.req as { title: string }).title).toBe('T-old');
  });

  it('splits a long session into parts within the limit and merges them', async () => {
    const messages = Array.from({ length: 6 }, (_, i) => text(i, 'user', 'w'.repeat(200)));
    add('long', { messages });
    await runOnce(deps({ maxInputTokens: 150 })); // 450 characters per part
    const digests = llm.calls.filter((c) => c.kind === 'digest').map((c) => c.req as { transcript: string; part: { index: number; total: number } });
    expect(digests.length).toBeGreaterThan(1);
    for (const d of digests) expect(d.transcript.length).toBeLessThanOrEqual(150 * CHARS_PER_TOKEN);
    expect(digests.map((d) => d.part.index)).toEqual(digests.map((_, i) => i + 1));
    expect(digests.every((d) => d.part.total === digests.length)).toBe(true);
    expect(llm.calls.filter((c) => c.kind === 'merge')).toHaveLength(1);
    expect(getDigest(db, rowId('long'))!.text).toContain(`merged ${digests.length} parts`);
  });

  it('handles an empty session without calling the model', async () => {
    add('empty', { messages: [] });
    expect(await runOnce(deps())).toBe('digest');
    expect(llm.calls.filter((c) => c.kind !== 'state')).toEqual([]);
    expect(getDigest(db, rowId('empty'))).toMatchObject({ status: 'ok' });
    expect(getDigest(db, rowId('empty'))!.text).toMatch(/Empty session/);
  });

  it('never digests a subagent transcript', async () => {
    add('a/agent-1', { parent: 'a' });
    expect(await runOnce(deps())).toBe('idle');
  });
});

describe('runOnce: failures', () => {
  it('schedules a retry after an error and digests on the next due attempt', async () => {
    add('a');
    llm.failWith = new Error('529 overloaded');
    expect(await runOnce(deps())).toBe('error');
    expect(getDigest(db, rowId('a'))).toMatchObject({ status: 'failed', attempts: 1, error: '529 overloaded' });
    expect(logs.join('\n')).toMatch(/claude-code:a.*529 overloaded/);
    expect(await runOnce(deps())).toBe('idle'); // not due yet
    clock += 60_000;
    expect(await runOnce(deps())).toBe('digest');
    expect(getDigest(db, rowId('a'))).toMatchObject({ status: 'ok', attempts: 0 });
  });

  // Review Focus 3
  it('marks a refused session, does not retry it, and still processes the others', async () => {
    add('bad', { last_activity_at: '2026-10-01T00:00:00.000Z' });
    add('good', { last_activity_at: '2026-10-02T00:00:00.000Z' });
    llm.failWith = new LlmRefusal('cyber');
    expect(await runOnce(deps())).toBe('error');
    expect(getDigest(db, rowId('bad'))).toMatchObject({ status: 'refused', error: 'cyber' });
    expect(await runOnce(deps())).toBe('digest');
    expect(getDigest(db, rowId('good'))!.status).toBe('ok');
    clock += 30 * 24 * 60 * 60_000;
    await drain();
    expect(getDigest(db, rowId('bad'))!.status).toBe('refused');
  });

  // Review Focus 2
  it('discards a digest when the session was uploaded again during the call, and digests the new content next', async () => {
    add('a', { messages: [text(0, 'user', 'first version')] });
    llm.onDigest = () => {
      llm.onDigest = null;
      add('a', { messages: [text(0, 'user', 'second version')] });
    };
    await runOnce(deps());
    expect(getDigest(db, rowId('a'))).toMatchObject({ status: 'pending', text: null });
    expect(logs.join('\n')).toMatch(/changed while/);
    await runOnce(deps());
    expect((llm.calls.at(-2)!.req as { transcript: string }).transcript).toContain('second version');
    expect(getDigest(db, rowId('a'))!.status).toBe('ok');
  });
});

describe('runOnce: project state', () => {
  it('builds the first page from scratch, then merges later digests into it', async () => {
    add('a', { last_activity_at: '2026-10-01T00:00:00.000Z' });
    await runOnce(deps());
    const first = llm.calls.find((c) => c.kind === 'state')!.req as { mode: string; previous: string | null; digests: { session_id: string }[] };
    expect(first).toMatchObject({ mode: 'rebuild', previous: null });
    expect(first.digests.map((d) => d.session_id)).toEqual(['claude-code:a']);
    expect(getProjectState(db, pid('alpha'))).toMatchObject({ summary: 'github.com/me/alpha: rebuild of 1', model: 'fake-model', dirty: false });

    add('b', { last_activity_at: '2026-10-02T00:00:00.000Z' });
    await runOnce(deps());
    const second = llm.calls.filter((c) => c.kind === 'state').at(-1)!.req as { mode: string; previous: string | null; digests: { session_id: string }[] };
    expect(second.mode).toBe('merge');
    expect(second.previous).toContain('mode=rebuild');
    expect(second.digests.map((d) => d.session_id)).toEqual(['claude-code:b']);
  });

  it('rebuilds from all digests once the last full rebuild is more than 7 days old', async () => {
    add('a', { last_activity_at: '2026-10-01T00:00:00.000Z' });
    await runOnce(deps());
    clock += REBUILD_AFTER_MS + 1000;
    add('b', { last_activity_at: '2026-10-02T00:00:00.000Z' });
    await runOnce(deps());
    const last = llm.calls.filter((c) => c.kind === 'state').at(-1)!.req as { mode: string; digests: { session_id: string }[] };
    expect(last.mode).toBe('rebuild');
    expect(last.digests.map((d) => d.session_id)).toEqual(['claude-code:a', 'claude-code:b']);
  });

  // Review Focus 4
  it('rebuilds the page without a deleted session, and removes the page when no digests are left', async () => {
    add('a', { last_activity_at: '2026-10-01T00:00:00.000Z' });
    add('b', { last_activity_at: '2026-10-02T00:00:00.000Z' });
    await drain();
    const p = pid('alpha');
    deleteSession(db, 'claude-code', 'a');
    expect(getProject(db, p, 5).state!.stale).toBe(true);
    expect(await runOnce(deps())).toBe('state');
    const rebuilt = llm.calls.filter((c) => c.kind === 'state').at(-1)!.req as { mode: string; digests: { session_id: string }[] };
    expect(rebuilt.mode).toBe('rebuild');
    expect(rebuilt.digests.map((d) => d.session_id)).toEqual(['claude-code:b']);
    expect(getProject(db, p, 5).state!.stale).toBe(false);

    // Now nothing usable is left: every digest refused, the page flagged.
    db.prepare("UPDATE digests SET status = 'refused', text = NULL").run();
    db.prepare('UPDATE project_states SET dirty = 1').run();
    const before = llm.calls.length;
    expect(await runOnce(deps())).toBe('state');
    expect(getProjectState(db, p)).toBeNull();
    expect(llm.calls.length).toBe(before); // nothing to summarise, so no model call
  });

  it('keeps the digest and leaves the page for later when updating the page fails', async () => {
    add('a');
    await drain();
    saveProjectState(db, pid('alpha'), { summary: 'old', body: 'old', model: 'm' }, iso(), true);
    add('b', { last_activity_at: '2026-10-02T00:00:00.000Z' });
    let n = 0;
    const flaky = Object.assign(Object.create(Object.getPrototypeOf(llm)), llm) as FakeLlm;
    flaky.projectState = async () => {
      n++;
      throw new Error('state call failed');
    };
    expect(await runOnce(deps({ llm: flaky }))).toBe('error');
    expect(n).toBe(1);
    expect(getDigest(db, rowId('b'))!.status).toBe('ok');
    expect(getProjectState(db, pid('alpha'))!.dirty).toBe(true);
    expect(await runOnce(deps())).toBe('idle'); // changed in review: a failed page waits before it is retried
    clock += 60_000;
    expect(await runOnce(deps())).toBe('state'); // the healthy model repairs it
    expect(getProjectState(db, pid('alpha'))!.dirty).toBe(false);
  });

  it('keeps the page stale when a session is deleted while the page is being rebuilt', async () => {
    add('a', { last_activity_at: '2026-10-01T00:00:00.000Z' });
    add('b', { last_activity_at: '2026-10-02T00:00:00.000Z' });
    await drain();
    const p = pid('alpha');
    db.prepare('UPDATE project_states SET dirty = 1').run();
    const racing = Object.assign(Object.create(Object.getPrototypeOf(llm)), llm) as FakeLlm;
    racing.projectState = async (req) => {
      deleteSession(db, 'claude-code', 'a');
      return FakeLlm.prototype.projectState.call(llm, req);
    };
    expect(await runOnce(deps({ llm: racing }))).toBe('state');
    expect(getProject(db, p, 5).state!.stale).toBe(true);
    expect(await runOnce(deps())).toBe('state');
    const last = llm.calls.filter((c) => c.kind === 'state').at(-1)!.req as { mode: string; digests: { session_id: string }[] };
    expect(last.digests.map((d) => d.session_id)).toEqual(['claude-code:b']);
    expect(getProject(db, p, 5).state!.stale).toBe(false);
  });

  it('on a rebuild that does not fit, sends the newest digests that do and the previous page', async () => {
    for (let i = 1; i <= 5; i++) add(`s${i}`, { last_activity_at: `2026-10-0${i}T00:00:00.000Z` });
    await drain();
    db.prepare('UPDATE project_states SET dirty = 1').run();
    const one = getDigest(db, rowId('s1'))!.text!.length;
    await runOnce(deps({ maxInputTokens: Math.ceil((one * 2.5) / CHARS_PER_TOKEN) }));
    const req = llm.calls.filter((c) => c.kind === 'state').at(-1)!.req as { mode: string; previous: string | null; digests: { session_id: string }[] };
    expect(req.mode).toBe('rebuild');
    expect(req.previous).not.toBeNull();
    expect(req.digests.map((d) => d.session_id)).toEqual(['claude-code:s4', 'claude-code:s5']);
  });
});

describe('runOnce: one page build per batch', () => {
  const count = (kind: 'digest' | 'merge' | 'state') => llm.calls.filter((c) => c.kind === kind).length;
  const addMany = (n: number, over: Parameters<typeof makeSession>[0] = {}, prefix = 's') =>
    Array.from({ length: n }, (_, i) => add(`${prefix}${i + 1}`, { last_activity_at: `2026-10-0${i + 1}T00:00:00.000Z`, ...over }));

  // Review Focus 1
  it('with a page and five pending digests: 5 digests, 0 merges, 1 rebuild, 1 review', async () => {
    add('first', { last_activity_at: '2026-09-01T00:00:00.000Z' });
    await drain();
    llm.calls = [];
    llm.reviews = [];
    addMany(5);
    await drain();
    expect(count('digest')).toBe(5);
    expect(count('merge')).toBe(0);
    expect(count('state')).toBe(1);
    expect(llm.reviews).toHaveLength(1);
    expect(getProjectState(db, pid('alpha'))!.dirty).toBe(false);
  });

  it('with no page and five pending digests: 5 digests, 1 page build, 1 review', async () => {
    addMany(5);
    await drain();
    expect(count('digest')).toBe(5);
    expect(count('state')).toBe(1);
    expect(llm.reviews).toHaveLength(1);
    expect(getProjectState(db, pid('alpha'))).not.toBeNull();
  });

  it('one new session with a page: 1 digest, 1 merge, 1 review, as before', async () => {
    add('first', { last_activity_at: '2026-09-01T00:00:00.000Z' });
    await drain();
    llm.calls = [];
    llm.reviews = [];
    add('b');
    await drain();
    expect(llm.calls.map((c) => `${c.kind}:${(c.req as { mode?: string }).mode ?? ''}`)).toEqual(['digest:', 'state:merge']);
    expect(llm.reviews).toHaveLength(1);
  });

  // Review Focus 2
  it('rebuilds each page once when two projects are interleaved, and leaves neither dirty', async () => {
    add('a0', { last_activity_at: '2026-09-01T00:00:00.000Z' });
    add('b0', { project_key: 'local:beta', last_activity_at: '2026-09-01T00:00:01.000Z' });
    await drain();
    llm.calls = [];
    llm.reviews = [];
    add('a1', { last_activity_at: '2026-10-01T00:00:00.000Z' });
    add('b1', { project_key: 'local:beta', last_activity_at: '2026-10-02T00:00:00.000Z' });
    add('a2', { last_activity_at: '2026-10-03T00:00:00.000Z' });
    add('b2', { project_key: 'local:beta', last_activity_at: '2026-10-04T00:00:00.000Z' });
    await drain();
    expect(count('digest')).toBe(4);
    expect(count('merge')).toBe(0);
    expect(count('state')).toBe(2);
    expect(llm.reviews).toHaveLength(2);
    expect(getProjectState(db, pid('alpha'))!.dirty).toBe(false);
    expect(getProjectState(db, pid('beta'))!.dirty).toBe(false);
  });

  it('does not hold a project page back for the digests of another project', async () => {
    add('a1', { last_activity_at: '2026-10-01T00:00:00.000Z' });
    add('b1', { project_key: 'local:beta', last_activity_at: '2026-10-02T00:00:00.000Z' });
    add('b2', { project_key: 'local:beta', last_activity_at: '2026-10-03T00:00:00.000Z' });
    await runOnce(deps()); // a1: no other alpha digest is due, so its page is built now
    expect(getProjectState(db, pid('alpha'))).not.toBeNull();
  });

  it('a failed digest waiting out its backoff does not count as still due', async () => {
    add('a', { last_activity_at: '2026-10-01T00:00:00.000Z' });
    add('b', { last_activity_at: '2026-10-02T00:00:00.000Z' });
    llm.failWith = new Error('529 overloaded');
    expect(await runOnce(deps())).toBe('error'); // a fails, backs off
    expect(await runOnce(deps())).toBe('digest'); // b: a is not due, so the page is built now
    expect(count('state')).toBe(1);
    expect(getProjectState(db, pid('alpha'))).not.toBeNull();
  });
});

describe('startWorker', () => {
  it('drains the queue in the background and stops cleanly', async () => {
    add('a');
    add('b');
    const worker = startWorker(deps(), 5);
    for (let i = 0; i < 200 && getDigest(db, rowId('b'))?.status !== 'ok'; i++) await new Promise((r) => setTimeout(r, 5));
    await worker.stop();
    expect(getDigest(db, rowId('a'))!.status).toBe('ok');
    expect(getDigest(db, rowId('b'))!.status).toBe('ok');
    const calls = llm.calls.length;
    add('c');
    await new Promise((r) => setTimeout(r, 30));
    expect(llm.calls.length).toBe(calls); // stopped means stopped
  });

  it('survives a job that throws something unexpected', async () => {
    add('a');
    const broken = deps({ now: () => { throw new Error('clock exploded'); } });
    const worker = startWorker(broken, 5);
    await new Promise((r) => setTimeout(r, 30));
    await worker.stop();
    expect(logs.join('\n')).toMatch(/clock exploded/);
  });
});

describe('runOnce: a state page that keeps failing', () => {
  /** A model whose digests work and whose state pages always fail. */
  const brokenState = (): { llm: FakeLlm; stateCalls: () => number } => {
    const broken = new FakeLlm();
    let n = 0;
    broken.projectState = async () => {
      n++;
      throw new Error('401 invalid key');
    };
    return { llm: broken, stateCalls: () => n };
  };

  it('waits before retrying instead of calling the model on every pass', async () => {
    add('a');
    const { llm: broken, stateCalls } = brokenState();
    const d = deps({ llm: broken });
    expect(await runOnce(d)).toBe('error'); // digest saved, first page attempt fails
    expect(stateCalls()).toBe(1);
    for (let i = 0; i < 10; i++) expect(await runOnce(d)).toBe('idle');
    expect(stateCalls()).toBe(1);
    clock += 60_000;
    expect(await runOnce(d)).toBe('error');
    expect(stateCalls()).toBe(2);
    clock += 60_000; // second wait is 5 minutes, so one minute is not enough
    expect(await runOnce(d)).toBe('idle');
    expect(stateCalls()).toBe(2);
    expect(logs.join('\n')).toMatch(/next try/);
  });

  it('does not block the page of another project', async () => {
    add('a');
    const { llm: broken } = brokenState();
    await runOnce(deps({ llm: broken })); // alpha: digest ok, page failed and now waiting
    add('b1', { project_key: 'local:beta' });
    expect(await runOnce(deps())).toBe('digest'); // healthy model: beta digest and page
    expect(getProjectState(db, pid('beta'))).not.toBeNull();
    expect(getProjectState(db, pid('alpha'))).toBeNull();
  });

  it('does not spend a page call per new digest while the project is waiting', async () => {
    add('a', { last_activity_at: '2026-10-01T00:00:00.000Z' });
    const { llm: broken, stateCalls } = brokenState();
    const d = deps({ llm: broken });
    await runOnce(d);
    add('b', { last_activity_at: '2026-10-02T00:00:00.000Z' });
    add('c', { last_activity_at: '2026-10-03T00:00:00.000Z' });
    expect(await runOnce(d)).toBe('digest');
    expect(await runOnce(d)).toBe('digest');
    expect(stateCalls()).toBe(1);
    expect(getDigest(db, rowId('c'))!.status).toBe('ok');
  });

  it('builds the page with every digest once the model recovers, and forgets the failures', async () => {
    add('a', { last_activity_at: '2026-10-01T00:00:00.000Z' });
    const { llm: broken } = brokenState();
    await runOnce(deps({ llm: broken }));
    add('b', { last_activity_at: '2026-10-02T00:00:00.000Z' });
    await runOnce(deps()); // digest b; alpha's page is still waiting
    clock += 60_000;
    expect(await runOnce(deps())).toBe('state');
    const req = llm.calls.filter((c) => c.kind === 'state').at(-1)!.req as { mode: string; digests: { session_id: string }[] };
    expect(req.digests.map((x) => x.session_id)).toEqual(['claude-code:a', 'claude-code:b']);
    expect(db.prepare('SELECT COUNT(*) AS n FROM state_retries').get()).toEqual({ n: 0 });
  });
});

describe('runOnce: page review', () => {
  const sectioned = async () => ({ summary: 'Part 3 awaits merge.', body: '## Current state\n\n- Part 3 awaits merge.\n\n## Open items\n\n- Confirm the key.\n- Set up backups.' });

  it('drops what the review names and uses its summary, with the newest digests as evidence', async () => {
    llm.projectState = sectioned;
    add('a', { last_activity_at: '2026-10-01T00:00:00.000Z' });
    add('b', { last_activity_at: '2026-10-02T00:00:00.000Z' });
    await drain();
    llm.nextReview = { drop_open: [{ item: 1, session_id: 'claude-code:b' }], drop_current: [{ item: 1, session_id: 'claude-code:b' }], summary: 'Merged and deployed.' };
    clock += REBUILD_AFTER_MS + 60_000;
    add('c', { last_activity_at: '2026-10-03T00:00:00.000Z' });
    await drain();
    const page = getProjectState(db, pid('alpha'))!;
    expect(page.summary).toBe('Merged and deployed.');
    expect(page.body).not.toContain('Confirm the key.');
    expect(page.body).not.toContain('- Part 3 awaits merge.');
    expect(page.body).toContain('- Set up backups.');
    expect(llm.reviews.at(-1)!.digests.map((d) => d.session_id)).toEqual(['claude-code:c', 'claude-code:b', 'claude-code:a']);
  });

  it('saves the page as written when the review fails', async () => {
    llm.projectState = sectioned;
    llm.nextReview = new Error('overloaded');
    add('a');
    await drain();
    expect(getProjectState(db, pid('alpha'))!.body).toContain('Confirm the key.');
    expect(logs.some((l) => /review skipped \(overloaded\)/.test(l))).toBe(true);
  });
});

describe('runOnce: notes', () => {
  const note = () => {
    const r = saveNote(db, { project: 'alpha', title: 'Pick Postgres', text: 'We chose Postgres for the queue.' }, iso());
    if (!r.ok) throw new Error('note not saved');
    return r.session_id;
  };
  const noteRow = (sid: string) => rowId(sid.replace(/^note:/, ''));

  it("stores a note's digest without calling the model", async () => {
    add('a');
    await drain();
    const sid = note();
    expect(await runOnce(deps())).toBe('digest');
    const d = getDigest(db, noteRow(sid))!;
    expect(d).toMatchObject({ status: 'ok', model: 'note' });
    expect(d.text!.startsWith('Note saved from a chat: Pick Postgres\n')).toBe(true);
    expect(d.text).toContain('We chose Postgres for the queue.');
    expect(llm.calls.filter((c) => c.kind === 'digest').map((c) => (c.req as { title: string }).title)).toEqual(['T-a']);
  });

  it('the note then reaches the state page', async () => {
    add('a');
    await drain();
    const sid = note();
    await drain();
    const req = llm.calls.filter((c) => c.kind === 'state').at(-1)!.req as { digests: { session_id: string }[] };
    expect(req.digests.map((d) => d.session_id)).toContain(sid);
  });

  it('a note waits like any other when digests are off', () => {
    add('a');
    const sid = note();
    expect(getDigest(db, noteRow(sid))!.status).toBe('pending');
    expect(search(db, { query: 'Postgres' }).some((h) => h.session_id === sid)).toBe(true);
  });
});
