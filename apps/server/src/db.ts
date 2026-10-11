import Database from 'better-sqlite3';

export type Db = Database.Database;

/** One entry per schema version. Never edit an entry that has shipped; append a new one. */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE projects (
    id          INTEGER PRIMARY KEY,
    key         TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    created_at  TEXT NOT NULL
  );

  CREATE TABLE sessions (
    id                 INTEGER PRIMARY KEY,
    source             TEXT NOT NULL,
    source_session_id  TEXT NOT NULL,
    project_id         INTEGER NOT NULL REFERENCES projects(id),
    account_id         TEXT,
    parent             TEXT,
    title              TEXT NOT NULL,
    cwd                TEXT,
    git_branch         TEXT,
    started_at         TEXT,
    last_activity_at   TEXT,
    content_hash       TEXT NOT NULL,
    synced_at          TEXT NOT NULL,
    UNIQUE (source, source_session_id)
  );
  CREATE INDEX sessions_project ON sessions(project_id, last_activity_at);

  CREATE TABLE messages (
    id           INTEGER PRIMARY KEY,
    session_id   INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq          INTEGER NOT NULL,
    role         TEXT NOT NULL,
    kind         TEXT NOT NULL,
    ts           TEXT,
    text         TEXT,
    tool_name    TEXT,
    tool_input   TEXT,
    tool_result  TEXT,
    tool_status  TEXT,
    UNIQUE (session_id, seq)
  );

  CREATE TABLE tokens (
    id            INTEGER PRIMARY KEY,
    label         TEXT NOT NULL,
    scope         TEXT NOT NULL CHECK (scope IN ('ingest', 'read')),
    hash          TEXT NOT NULL UNIQUE,
    created_at    TEXT NOT NULL,
    revoked_at    TEXT,
    last_used_at  TEXT
  );

  -- kind is 'title', 'message' or 'tool' here; Part 3 adds 'digest'.
  CREATE VIRTUAL TABLE search_index USING fts5(
    body,
    kind UNINDEXED,
    session_id UNINDEXED,
    seq UNINDEXED,
    tokenize = 'unicode61'
  );
  `,
  `
  -- One row per main session. This table is also the work queue.
  CREATE TABLE digests (
    session_id       INTEGER PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    status           TEXT NOT NULL CHECK (status IN ('pending', 'ok', 'failed', 'refused')),
    source_hash      TEXT,
    model            TEXT,
    body             TEXT,
    text             TEXT,
    attempts         INTEGER NOT NULL DEFAULT 0,
    next_attempt_at  TEXT,
    error            TEXT,
    updated_at       TEXT NOT NULL
  );
  CREATE INDEX digests_status ON digests(status, next_attempt_at);

  CREATE TABLE project_states (
    project_id  INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    summary     TEXT NOT NULL,
    body        TEXT NOT NULL,
    model       TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    rebuilt_at  TEXT NOT NULL,
    dirty       INTEGER NOT NULL DEFAULT 0
  );
  `,
  `
  -- A project whose state page could not be written waits here before the next try.
  CREATE TABLE state_retries (
    project_id       INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    attempts         INTEGER NOT NULL,
    next_attempt_at  TEXT NOT NULL,
    error            TEXT
  );

  -- Sessions stored before digests existed get one queued.
  INSERT INTO digests(session_id, status, updated_at)
  SELECT id, 'pending', synced_at FROM sessions
  WHERE parent IS NULL AND id NOT IN (SELECT session_id FROM digests);
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
  return db;
}
