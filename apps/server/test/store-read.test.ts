import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db.js';
import { getProject, getSessionPage, listProjects, PAGE_BUDGET, resolveProject, upsertSession, type SessionPage } from '../src/store.js';
import { makeSession, text, tool } from './helpers.js';

const NOW = '2026-10-11T00:00:00.000Z';
let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
  upsertSession(db, makeSession({ source_session_id: 'a1', last_activity_at: '2026-10-01T00:00:00.000Z', title: 'Old alpha work' }), NOW);
  upsertSession(db, makeSession({ source_session_id: 'a2', last_activity_at: '2026-10-05T00:00:00.000Z', title: 'New alpha work' }), NOW);
  upsertSession(db, makeSession({ source_session_id: 'a2/agent-1', parent: 'a2', last_activity_at: '2026-10-06T00:00:00.000Z' }), NOW);
  upsertSession(db, makeSession({ source: 'codex', source_session_id: 'b1', project_key: 'local:Beta', last_activity_at: '2026-10-03T00:00:00.000Z' }), NOW);
});

describe('listProjects', () => {
  it('lists projects by latest activity, counting main sessions only', () => {
    expect(listProjects(db)).toEqual([
      { key: 'github.com/me/alpha', name: 'alpha', session_count: 2, last_activity_at: '2026-10-06T00:00:00.000Z', last_synced_at: NOW, summary: null },
      { key: 'local:Beta', name: 'Beta', session_count: 1, last_activity_at: '2026-10-03T00:00:00.000Z', last_synced_at: NOW, summary: null },
    ]);
  });

  it('is empty for an empty database', () => {
    expect(listProjects(openDb(':memory:'))).toEqual([]);
  });
});

describe('resolveProject', () => {
  it.each([['github.com/me/alpha'], ['alpha'], ['ALPHA'], ['GitHub.com/Me/Alpha']])('finds alpha from %s', (input) => {
    expect(resolveProject(db, input)).toMatchObject({ ok: true, key: 'github.com/me/alpha' });
  });

  it('finds a local project by name or key, in any case', () => {
    expect(resolveProject(db, 'beta')).toMatchObject({ ok: true, key: 'local:Beta' });
    expect(resolveProject(db, 'local:beta')).toMatchObject({ ok: true, key: 'local:Beta' });
  });

  it('lists every project when nothing matches', () => {
    expect(resolveProject(db, 'gamma')).toEqual({ ok: false, candidates: ['github.com/me/alpha', 'local:Beta'] });
  });

  it('returns only the matching candidates when a name is ambiguous', () => {
    upsertSession(db, makeSession({ source_session_id: 'c1', project_key: 'github.com/other/alpha' }), NOW);
    expect(resolveProject(db, 'alpha')).toEqual({ ok: false, candidates: ['github.com/me/alpha', 'github.com/other/alpha'] });
  });

  it('an exact key wins even when its name is shared', () => {
    upsertSession(db, makeSession({ source_session_id: 'c1', project_key: 'github.com/other/alpha' }), NOW);
    expect(resolveProject(db, 'github.com/other/alpha')).toMatchObject({ ok: true, key: 'github.com/other/alpha' });
  });
});

describe('getProject', () => {
  it('returns the latest main sessions, newest first, with empty digest and state until Part 3', () => {
    const resolved = resolveProject(db, 'alpha');
    if (!resolved.ok) throw new Error('expected a match');
    const view = getProject(db, resolved.id, 5);
    expect(view).toMatchObject({ key: 'github.com/me/alpha', name: 'alpha', state: null, last_synced_at: NOW });
    expect(view.recent.map((s) => [s.session_id, s.title, s.is_subagent, s.digest])).toEqual([
      ['claude-code:a2', 'New alpha work', false, null],
      ['claude-code:a1', 'Old alpha work', false, null],
    ]);
  });

  it('honours the session limit', () => {
    const resolved = resolveProject(db, 'alpha');
    if (!resolved.ok) throw new Error('expected a match');
    expect(getProject(db, resolved.id, 1).recent).toHaveLength(1);
  });
});

describe('getSessionPage', () => {
  it('returns session details and all messages when they fit', () => {
    const page = getSessionPage(db, 'claude-code', 'a1', 0)!;
    expect(page.session).toMatchObject({
      session_id: 'claude-code:a1',
      project: 'github.com/me/alpha',
      title: 'Old alpha work',
      cwd: '/work/alpha',
      message_count: 2,
      is_subagent: false,
      last_synced_at: NOW,
    });
    expect(page.messages.map((m) => m.seq)).toEqual([0, 1]);
    expect(page.next_seq).toBeNull();
  });

  it('returns tool calls with their fields', () => {
    upsertSession(db, makeSession({ source_session_id: 't1', messages: [tool(0, 'Bash', 'ls', 'a.ts')] }), NOW);
    expect(getSessionPage(db, 'claude-code', 't1', 0)!.messages).toEqual([
      { seq: 0, role: 'assistant', kind: 'tool_call', ts: null, tool_name: 'Bash', tool_input: 'ls', tool_result: 'a.ts', tool_status: 'ok' },
    ]);
  });

  it('pages by character budget and continues from next_seq without gaps or repeats', () => {
    const messages = Array.from({ length: 10 }, (_, i) => text(i, 'user', 'x'.repeat(100)));
    upsertSession(db, makeSession({ source_session_id: 'long', messages }), NOW);
    const seen: number[] = [];
    let from: number | null = 0;
    let pages = 0;
    while (from !== null) {
      const page: SessionPage = getSessionPage(db, 'claude-code', 'long', from, 350)!;
      seen.push(...page.messages.map((m) => m.seq));
      from = page.next_seq;
      pages++;
      expect(pages).toBeLessThan(20);
    }
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(pages).toBeGreaterThan(1);
  });

  // Review Focus 5
  it('returns a message larger than the whole budget alone and still advances', () => {
    const messages = [text(0, 'user', 'small'), text(1, 'assistant', 'y'.repeat(PAGE_BUDGET * 2)), text(2, 'user', 'after')];
    upsertSession(db, makeSession({ source_session_id: 'huge', messages }), NOW);
    const first = getSessionPage(db, 'claude-code', 'huge', 0)!;
    expect(first.messages.map((m) => m.seq)).toEqual([0]);
    expect(first.next_seq).toBe(1);
    const second = getSessionPage(db, 'claude-code', 'huge', 1)!;
    expect(second.messages.map((m) => m.seq)).toEqual([1]);
    expect(second.next_seq).toBe(2);
    const third = getSessionPage(db, 'claude-code', 'huge', 2)!;
    expect(third.messages.map((m) => m.seq)).toEqual([2]);
    expect(third.next_seq).toBeNull();
  });

  it('returns an empty page past the end and null for an unknown session', () => {
    expect(getSessionPage(db, 'claude-code', 'a1', 99)).toMatchObject({ messages: [], next_seq: null });
    expect(getSessionPage(db, 'claude-code', 'nope', 0)).toBeNull();
  });

  it('marks a subagent transcript', () => {
    expect(getSessionPage(db, 'claude-code', 'a2/agent-1', 0)!.session.is_subagent).toBe(true);
  });
});
