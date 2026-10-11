import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db.js';
import { deleteProject, deleteSession, projectName, publicId, splitPublicId, status, upsertSession } from '../src/store.js';
import { makeSession, text, tool } from './helpers.js';

const NOW = '2026-10-11T00:00:00.000Z';
const LATER = '2026-10-12T00:00:00.000Z';
let db: Db;
const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

beforeEach(() => {
  db = openDb(':memory:');
});

describe('ids and names', () => {
  it('builds and splits public ids, keeping colons and slashes inside the id', () => {
    expect(publicId('claude-code', 'abc/agent-1')).toBe('claude-code:abc/agent-1');
    expect(splitPublicId('claude-code:abc/agent:1')).toEqual({ source: 'claude-code', id: 'abc/agent:1' });
    expect(splitPublicId('no-colon')).toBeNull();
    expect(splitPublicId(':x')).toBeNull();
  });

  it.each([
    ['github.com/me/alpha', 'alpha'],
    ['local:notes', 'notes'],
    ['unfiled', 'unfiled'],
  ])('projectName(%s) is %s', (key, name) => {
    expect(projectName(key)).toBe(name);
  });
});

describe('upsertSession', () => {
  it('stores the session, its messages and a project', () => {
    expect(upsertSession(db, makeSession(), NOW)).toEqual({ changed: true });
    expect(count('projects')).toBe(1);
    expect(count('sessions')).toBe(1);
    expect(count('messages')).toBe(2);
    expect(db.prepare('SELECT name FROM projects').get()).toEqual({ name: 'alpha' });
    expect(db.prepare('SELECT synced_at, title FROM sessions').get()).toEqual({ synced_at: NOW, title: 'Fix the login bug' });
  });

  it('indexes the title, text messages and tool calls for search', () => {
    upsertSession(db, makeSession({ messages: [text(0, 'user', 'hello'), tool(1, 'Bash', 'pnpm test', 'ok')] }), NOW);
    const kinds = (db.prepare('SELECT kind, body FROM search_index ORDER BY kind').all() as { kind: string; body: string }[]).map(
      (r) => `${r.kind}:${r.body}`,
    );
    expect(kinds).toEqual(['message:hello', 'title:Fix the login bug', 'tool:Bash pnpm test']);
  });

  it('does nothing when the same session is sent twice', () => {
    upsertSession(db, makeSession(), NOW);
    expect(upsertSession(db, makeSession(), LATER)).toEqual({ changed: false });
    expect(count('messages')).toBe(2);
    expect(db.prepare('SELECT synced_at FROM sessions').get()).toEqual({ synced_at: NOW });
  });

  it('replaces messages and index rows when the session changed', () => {
    upsertSession(db, makeSession(), NOW);
    const grown = makeSession({ messages: [text(0, 'user', 'one'), text(1, 'assistant', 'two'), text(2, 'user', 'three')] });
    expect(upsertSession(db, grown, LATER)).toEqual({ changed: true });
    expect(count('sessions')).toBe(1);
    expect(count('messages')).toBe(3);
    expect(count('search_index')).toBe(4); // title + 3 messages
    expect(db.prepare('SELECT synced_at FROM sessions').get()).toEqual({ synced_at: LATER });
  });

  // Review Focus 1
  it('removes a project left empty when a session moves to another project', () => {
    upsertSession(db, makeSession(), NOW);
    upsertSession(db, makeSession({ project_key: 'local:renamed' }), LATER);
    expect(db.prepare('SELECT key FROM projects').all()).toEqual([{ key: 'local:renamed' }]);
    expect(count('sessions')).toBe(1);
  });

  it('keeps a project that still has other sessions', () => {
    upsertSession(db, makeSession({ source_session_id: 's1' }), NOW);
    upsertSession(db, makeSession({ source_session_id: 's2' }), NOW);
    upsertSession(db, makeSession({ source_session_id: 's2', project_key: 'local:other' }), LATER);
    expect((db.prepare('SELECT key FROM projects ORDER BY key').all() as { key: string }[]).map((r) => r.key)).toEqual([
      'github.com/me/alpha',
      'local:other',
    ]);
  });

  it('treats the same id from two tools as two sessions', () => {
    upsertSession(db, makeSession({ source: 'claude-code' }), NOW);
    upsertSession(db, makeSession({ source: 'codex' }), NOW);
    expect(count('sessions')).toBe(2);
  });
});

describe('deleteSession and deleteProject', () => {
  beforeEach(() => {
    upsertSession(db, makeSession({ source_session_id: 'main' }), NOW);
    upsertSession(db, makeSession({ source_session_id: 'main/agent-1', parent: 'main' }), NOW);
    upsertSession(db, makeSession({ source_session_id: 'other', project_key: 'local:beta' }), NOW);
  });

  it('removes a session together with its subagent transcripts and all their rows', () => {
    expect(deleteSession(db, 'claude-code', 'main')).toBe(2);
    expect(count('sessions')).toBe(1);
    expect(count('messages')).toBe(2);
    expect(db.prepare("SELECT COUNT(*) AS n FROM search_index WHERE body LIKE '%login%'").get()).toEqual({ n: 2 });
    expect(db.prepare('SELECT key FROM projects').all()).toEqual([{ key: 'local:beta' }]);
  });

  it('returns 0 for a session that does not exist', () => {
    expect(deleteSession(db, 'claude-code', 'nope')).toBe(0);
    expect(count('sessions')).toBe(3);
  });

  it('removes a whole project', () => {
    expect(deleteProject(db, 'github.com/me/alpha')).toBe(2);
    expect(count('sessions')).toBe(1);
    expect(deleteProject(db, 'github.com/me/alpha')).toBe(0);
  });
});

describe('status', () => {
  it('counts rows and reports the last sync per project', () => {
    upsertSession(db, makeSession({ source_session_id: 'a' }), NOW);
    upsertSession(db, makeSession({ source_session_id: 'b' }), LATER);
    upsertSession(db, makeSession({ source_session_id: 'c', project_key: 'local:beta' }), NOW);
    expect(status(db)).toEqual({
      projects: 2,
      sessions: 3,
      messages: 6,
      last_sync: [
        { project: 'github.com/me/alpha', last_synced_at: LATER },
        { project: 'local:beta', last_synced_at: NOW },
      ],
    });
  });
});
