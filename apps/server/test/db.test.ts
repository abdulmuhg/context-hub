import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb, SCHEMA_VERSION, type Db } from '../src/db.js';
import { projectsNeedingPage } from '../src/digest-store.js';

/** Puts a fresh database back to how migration 8 left it, so the later migrations run again. */
function unmigrate9(db: Db): void {
  db.exec('DROP TABLE page_skips');
  db.exec('DROP TABLE server_page_queue');
  for (const c of ['written_by', 'summary_to_follow', 'saved_seq']) db.exec(`ALTER TABLE digests DROP COLUMN ${c}`);
  for (const c of ['version', 'digests_through', 'written_by']) db.exec(`ALTER TABLE project_states DROP COLUMN ${c}`);
}

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
  it('creates the dashboard tables', () => {
    const db = openDb(':memory:');
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(5);
    expect(tables(db)).toEqual(expect.arrayContaining(['activity', 'sync_runs', 'web_sessions']));
  });
});

describe('migration 6', () => {
  it('gives connect_codes a purpose', () => {
    const db = openDb(':memory:');
    const cols = (db.prepare('PRAGMA table_info(connect_codes)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('purpose');
  });
});

describe('migration 7', () => {
  it('is schema version 7 and drops "your PC" from saved activity', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(7);
    const path = join(mkdtempSync(join(tmpdir(), 'hub-db-')), 'hub.sqlite');
    const old = openDb(path);
    old.exec('DROP TABLE model_usage');
    unmigrate9(old);
    old.pragma('user_version = 6');
    const add = old.prepare("INSERT INTO activity(at, direction, action, actor) VALUES ('2026-10-21T00:00:00Z', 'in', 'sync', ?)");
    for (const actor of ['your PC (abdulmuhg-macOS)', 'your PC', 'claude.ai']) add.run(actor);
    old.close();
    const db = openDb(path);
    expect((db.prepare('SELECT actor FROM activity ORDER BY id').all() as { actor: string }[]).map((r) => r.actor)).toEqual([
      'abdulmuhg-macOS',
      'a computer',
      'claude.ai',
    ]);
    db.close();
  });
});

describe('migration 8', () => {
  it('is schema version 8 and creates model_usage', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(8);
    const db = openDb(':memory:');
    expect(tables(db)).toContain('model_usage');
    const cols = (db.prepare('PRAGMA table_info(model_usage)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(['id', 'at', 'model', 'kind', 'project_key', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'cost_micro_usd']);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'model_usage_at'").get()).toBeDefined();
  });
});

describe('migration 9', () => {
  it('keeps existing pages up to date', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'hub-db-')), 'hub.sqlite');
    const old = openDb(path);
    old.prepare("INSERT INTO projects(key, name, created_at) VALUES ('p', 'p', 'x')").run();
    old.prepare(
      "INSERT INTO sessions(source, source_session_id, project_id, title, last_activity_at, content_hash, synced_at) VALUES ('claude-code', 's', 1, 't', 'x', 'h', 'x')",
    ).run();
    old.prepare("INSERT INTO digests(session_id, status, source_hash, model, body, text, updated_at) VALUES (1, 'ok', 'h', 'm', '{}', 't', 'x')").run();
    old.prepare("INSERT INTO project_states(project_id, summary, body, model, updated_at, rebuilt_at, dirty) VALUES (1, 's', 'b', 'm', 'x', 'x', 0)").run();
    unmigrate9(old);
    old.pragma('user_version = 8');
    old.close();
    const db = openDb(path);
    expect(projectsNeedingPage(db)).toEqual([]);
    expect(db.prepare('SELECT version, digests_through FROM project_states').get()).toEqual({ version: 1, digests_through: 0 });
    db.close();
  });
});
