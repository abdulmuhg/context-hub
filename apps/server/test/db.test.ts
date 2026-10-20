import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb, SCHEMA_VERSION } from '../src/db.js';

const tables = (db: ReturnType<typeof openDb>) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table') ORDER BY name").all() as { name: string }[]).map((r) => r.name);

describe('openDb', () => {
  it('creates every table and records the schema version', () => {
    const db = openDb(':memory:');
    expect(tables(db)).toEqual(expect.arrayContaining(['messages', 'projects', 'search_index', 'sessions', 'tokens']));
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
  });

  it('has full-text search available', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO search_index(body, kind, session_id, seq) VALUES ('hello world', 'message', 1, 0)").run();
    const hit = db.prepare("SELECT session_id FROM search_index WHERE search_index MATCH '\"hello\"'").get();
    expect(hit).toEqual({ session_id: 1 });
  });

  it('enforces foreign keys', () => {
    const db = openDb(':memory:');
    expect(() =>
      db.prepare("INSERT INTO messages(session_id, seq, role, kind) VALUES (999, 0, 'user', 'text')").run(),
    ).toThrow(/FOREIGN KEY/);
  });

  it('can be opened twice on the same file without losing data or re-running migrations', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'hub-db-')), 'hub.sqlite');
    const first = openDb(path);
    first.prepare("INSERT INTO projects(key, name, created_at) VALUES ('local:a', 'a', '2026-10-11T00:00:00Z')").run();
    first.close();
    const second = openDb(path);
    expect(second.prepare('SELECT COUNT(*) AS n FROM projects').get()).toEqual({ n: 1 });
    second.close();
  });
});

describe('migration 4', () => {
  it('is at least schema version 4 and creates the OAuth tables', () => {
    const db = openDb(':memory:');
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(4);
    expect(tables(db)).toEqual(
      expect.arrayContaining(['oauth_clients', 'connect_codes', 'oauth_grants', 'oauth_codes', 'oauth_tokens']),
    );
  });
});

describe('migration 5', () => {
  it('is schema version 5 and creates the dashboard tables', () => {
    const db = openDb(':memory:');
    expect(SCHEMA_VERSION).toBe(5);
    expect(tables(db)).toEqual(expect.arrayContaining(['activity', 'sync_runs', 'web_sessions']));
  });
});
