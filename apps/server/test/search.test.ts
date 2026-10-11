import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db.js';
import { search, toFtsQuery } from '../src/search.js';
import { resolveProject, upsertSession } from '../src/store.js';
import { makeSession, text, tool } from './helpers.js';

const NOW = '2026-10-11T00:00:00.000Z';
let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
  upsertSession(
    db,
    makeSession({
      source_session_id: 'a1',
      title: 'Redis cache removal',
      last_activity_at: '2026-10-01T09:00:00.000Z',
      messages: [text(0, 'user', 'why did we drop redis from the stack'), text(1, 'assistant', 'Because the cache hit rate was under five percent.')],
    }),
    NOW,
  );
  upsertSession(
    db,
    makeSession({
      source: 'codex',
      source_session_id: 'b1',
      project_key: 'local:beta',
      title: 'Deploy script',
      last_activity_at: '2026-10-08T09:00:00.000Z',
      messages: [text(0, 'user', 'the deploy script fails on the cache step'), tool(1, 'shell', 'bash scripts/deploy.sh --dry-run', 'exit 1')],
    }),
    NOW,
  );
  upsertSession(db, makeSession({ source_session_id: 'a1/agent-1', parent: 'a1', title: 'sub', messages: [text(0, 'user', 'investigate redis eviction')] }), NOW);
});

describe('toFtsQuery', () => {
  it.each([
    ['redis cache', '"redis" "cache"'],
    ['"hit rate" redis', '"hit rate" "redis"'],
    ['  ', null],
    ['""', null],
    ['foo AND (', '"foo" "AND" "("'],
    ['"abc', '"abc"'],
    ['NEAR/2 col:x -y *', '"NEAR/2" "col:x" "-y" "*"'],
    ['say "hi" there"', '"say" "hi" "there"'],
  ])('%s -> %s', (input, expected) => {
    expect(toFtsQuery(input)).toBe(expected);
  });
});

describe('search', () => {
  it('finds a message and returns where it is', () => {
    const hits = search(db, { query: 'hit rate' });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      session_id: 'claude-code:a1',
      project: 'github.com/me/alpha',
      source: 'claude-code',
      title: 'Redis cache removal',
      kind: 'message',
      seq: 1,
      is_subagent: false,
    });
    expect(hits[0]!.snippet).toContain('[hit] [rate]');
  });

  it('requires every word', () => {
    expect(search(db, { query: 'redis deploy' })).toEqual([]);
  });

  it('matches an exact phrase only in that order', () => {
    expect(search(db, { query: '"cache hit rate"' })).toHaveLength(1);
    expect(search(db, { query: '"rate hit cache"' })).toEqual([]);
  });

  it('ranks a title hit above message hits and gives it a null seq', () => {
    const hits = search(db, { query: 'redis' });
    expect(hits[0]).toMatchObject({ kind: 'title', seq: null, session_id: 'claude-code:a1' });
    expect(hits.map((h) => h.kind)).toContain('message');
  });

  it('finds tool calls by command text', () => {
    expect(search(db, { query: 'deploy.sh' })[0]).toMatchObject({ kind: 'tool', seq: 1, session_id: 'codex:b1' });
  });

  it('marks subagent hits', () => {
    const hit = search(db, { query: 'eviction' })[0]!;
    expect(hit).toMatchObject({ session_id: 'claude-code:a1/agent-1', is_subagent: true });
  });

  it('filters by project, source and date range', () => {
    const beta = resolveProject(db, 'beta');
    if (!beta.ok) throw new Error('expected a match');
    expect(search(db, { query: 'cache', projectId: beta.id }).map((h) => h.session_id)).toEqual(['codex:b1']);
    expect(search(db, { query: 'cache', source: 'claude-code' }).every((h) => h.source === 'claude-code')).toBe(true);
    expect(search(db, { query: 'cache', since: '2026-10-05' }).map((h) => h.session_id)).toEqual(['codex:b1']);
    expect(search(db, { query: 'cache', until: '2026-10-01' }).every((h) => h.session_id.startsWith('claude-code:a1'))).toBe(true);
    expect(search(db, { query: 'cache', since: '2026-10-08', until: '2026-10-08' })).toHaveLength(1);
  });

  it('honours the limit and caps it at 50', () => {
    for (let i = 0; i < 60; i++) {
      upsertSession(db, makeSession({ source_session_id: `bulk-${i}`, title: 't', messages: [text(0, 'user', 'zebra crossing')] }), NOW);
    }
    expect(search(db, { query: 'zebra', limit: 3 })).toHaveLength(3);
    expect(search(db, { query: 'zebra' })).toHaveLength(10);
    expect(search(db, { query: 'zebra', limit: 500 })).toHaveLength(50);
  });

  // Review Focus 4
  it.each([['foo AND ('], ['"abc'], ['NEAR/2'], ['*'], ['col:x'], ['-redis'], ['^redis'], ['a OR b NOT c'], ['{}[]()']])(
    'does not fail on %s',
    (query) => {
      expect(() => search(db, { query })).not.toThrow();
    },
  );

  it('returns nothing for an empty query', () => {
    expect(search(db, { query: '   ' })).toEqual([]);
  });

  it('ignores a malformed date instead of failing', () => {
    expect(search(db, { query: 'cache', since: 'yesterday' }).length).toBeGreaterThan(0);
  });
});

describe('search: control characters', () => {
  it.each([['\u0000'], ['redis\u0000cache'], ['\u0001\u0002'], ['a\tb\nc']])('does not fail on %j', (query) => {
    expect(() => search(db, { query })).not.toThrow();
  });

  it('treats a control character as a word break', () => {
    expect(toFtsQuery('redis\u0000cache')).toBe('"redis" "cache"');
    expect(toFtsQuery('\u0000')).toBeNull();
  });
});
