import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../src/db.js';
import { markSummaryToFollow, saveDigest, type DigestBody } from '../src/digest-store.js';
import { search } from '../src/search.js';
import { deleteSession, upsertSession } from '../src/store.js';
import { makeSession, text } from './helpers.js';

const NOW = '2026-10-11T00:00:00.000Z';
const BODY: DigestBody = { goal: 'g', done: [], decisions: [], open_items: [], key_refs: [] };
let db: Db;

/**
 * The query plan of every statement that reads or deletes search rows while `run` runs.
 * A plan of "INDEX 0:" visits every row of the index, and so does "INDEX 0:><": FTS5 checks a
 * rowid range row by row. Only a rowid looked up by equality ("INDEX 0:=") skips the rest.
 */
const SCANS_INDEX = /VIRTUAL TABLE INDEX 0:[<>]*( \||$)/;
function plans(run: () => void): string[] {
  const out: string[] = [];
  const prepare = db.prepare.bind(db);
  const spy = vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
    const stmt = prepare(sql);
    if (!sql.includes('search_index') || /^\s*INSERT/i.test(sql)) return stmt;
    for (const method of ['run', 'all', 'get'] as const) {
      const original = stmt[method].bind(stmt) as (...args: unknown[]) => unknown;
      (stmt as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
        const rows = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[];
        out.push(rows.map((r) => r.detail).join(' | '));
        return original(...args);
      };
    }
    return stmt;
  }) as typeof db.prepare);
  try {
    run();
  } finally {
    spy.mockRestore();
  }
  return out;
}

const rowId = (id: string) => (db.prepare('SELECT id, content_hash FROM sessions WHERE source_session_id = ?').get(id) as { id: number; content_hash: string });

beforeEach(() => {
  db = openDb(':memory:');
  upsertSession(db, makeSession({ source_session_id: 'a', messages: [text(0, 'user', 'kiwi one')] }), NOW);
  upsertSession(db, makeSession({ source_session_id: 'b', messages: [text(0, 'user', 'kiwi two')] }), NOW);
});

describe('search rows are found by their session, not by scanning the index', () => {
  it('when a changed session is stored again', () => {
    const found = plans(() => upsertSession(db, makeSession({ source_session_id: 'a', messages: [text(0, 'user', 'kiwi grown')] }), NOW));
    expect(found.length).toBeGreaterThan(0);
    for (const plan of found) expect(plan).not.toMatch(SCANS_INDEX);
  });

  it('when a session is deleted', () => {
    const found = plans(() => deleteSession(db, 'claude-code', 'a'));
    expect(found.length).toBeGreaterThan(0);
    for (const plan of found) expect(plan).not.toMatch(SCANS_INDEX);
  });

  it('when a digest is saved or taken away', () => {
    const a = rowId('a');
    const found = plans(() => {
      saveDigest(db, { sessionRowId: a.id, hash: a.content_hash, model: 'm', body: BODY, text: 'first digest', now: NOW });
      saveDigest(db, { sessionRowId: a.id, hash: a.content_hash, model: 'm', body: BODY, text: 'second digest', now: NOW });
      markSummaryToFollow(db, a.id, NOW);
    });
    expect(found.length).toBeGreaterThan(0);
    for (const plan of found) expect(plan).not.toMatch(SCANS_INDEX);
  });

  it('leaves the other sessions\' rows alone', () => {
    const a = rowId('a');
    saveDigest(db, { sessionRowId: a.id, hash: a.content_hash, model: 'm', body: BODY, text: 'kiwi digest', now: NOW });
    deleteSession(db, 'claude-code', 'a');
    expect(search(db, { query: 'kiwi' }).map((h) => `${h.session_id} ${h.kind}`)).toEqual(['claude-code:b message']);
  });
});

describe('search', () => {
  it('ranks without sorting every match', () => {
    const found = plans(() => {
      search(db, { query: 'kiwi' });
      search(db, { query: 'kiwi', projectId: 1, since: '2026-01-01' });
    });
    expect(found.length).toBeGreaterThan(0);
    for (const plan of found) expect(plan).not.toMatch(/TEMP B-TREE/);
  });
});
