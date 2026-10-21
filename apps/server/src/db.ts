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
  `
  -- Sign-in for the Claude apps. Every secret is stored as a sha256 hex hash only.
  CREATE TABLE oauth_clients (
    client_id      TEXT PRIMARY KEY,
    kind           TEXT NOT NULL CHECK (kind IN ('dcr', 'cimd')),
    name           TEXT NOT NULL,
    redirect_uris  TEXT NOT NULL,
    created_at     TEXT NOT NULL,
    fetched_at     TEXT NOT NULL
  );

  CREATE TABLE connect_codes (
    hash        TEXT NOT NULL UNIQUE,
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    used_at     TEXT
  );

  CREATE TABLE oauth_grants (
    id            INTEGER PRIMARY KEY,
    client_id     TEXT NOT NULL,
    client_name   TEXT NOT NULL,
    scopes        TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    last_used_at  TEXT,
    revoked_at    TEXT
  );

  CREATE TABLE oauth_codes (
    hash            TEXT PRIMARY KEY,
    grant_id        INTEGER NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
    client_id       TEXT NOT NULL,
    redirect_uri    TEXT NOT NULL,
    code_challenge  TEXT NOT NULL,
    resource        TEXT NOT NULL,
    expires_at      TEXT NOT NULL,
    used_at         TEXT
  );

  -- pair_hash links an access token to the refresh token issued with it.
  CREATE TABLE oauth_tokens (
    hash         TEXT PRIMARY KEY,
    grant_id     INTEGER NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
    expires_at   TEXT NOT NULL,
    replaced_at  TEXT,
    replaced_by  TEXT,
    pair_hash    TEXT
  );
  CREATE INDEX oauth_tokens_pair ON oauth_tokens(pair_hash);
  CREATE INDEX oauth_tokens_grant ON oauth_tokens(grant_id);
  `,
  `
  -- What the hub did for the dashboard: calls in (uploads, notes, syncs) and out (answers to Claude).
  CREATE TABLE activity (
    id           INTEGER PRIMARY KEY,
    at           TEXT NOT NULL,
    direction    TEXT NOT NULL CHECK (direction IN ('in', 'out')),
    action       TEXT NOT NULL,
    project_key  TEXT,
    session_ref  TEXT,
    actor        TEXT NOT NULL,
    detail       TEXT
  );
  CREATE INDEX activity_at ON activity(at);

  -- One row per run the collector reports after hub sync.
  CREATE TABLE sync_runs (
    id           INTEGER PRIMARY KEY,
    token_id     INTEGER NOT NULL,
    finished_at  TEXT NOT NULL,
    uploaded     INTEGER NOT NULL,
    unchanged    INTEGER NOT NULL,
    errors       INTEGER NOT NULL,
    received_at  TEXT NOT NULL
  );

  -- Browser sign-ins for the dashboard. The cookie value is stored as a sha256 hex hash only.
  CREATE TABLE web_sessions (
    id            INTEGER PRIMARY KEY,
    hash          TEXT NOT NULL UNIQUE,
    csrf          TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    last_used_at  TEXT NOT NULL,
    expires_at    TEXT NOT NULL,
    revoked_at    TEXT
  );
  `,
  `
  -- A one-time code is for signing in (Claude apps, browsers) or for adding a computer; never both.
  ALTER TABLE connect_codes ADD COLUMN purpose TEXT NOT NULL DEFAULT 'signin' CHECK (purpose IN ('signin','device'));
  `,
  `
  -- The activity log names a computer by its label alone, not "your PC (<label>)".
  UPDATE activity SET actor = substr(actor, 10, length(actor) - 10) WHERE actor LIKE 'your PC (%)';
  UPDATE activity SET actor = 'a computer' WHERE actor = 'your PC';
  `,
  `
  -- Real token counts and cost of every model call. Counts only: no prompt or transcript text.
  CREATE TABLE model_usage (
    id                 INTEGER PRIMARY KEY,
    at                 TEXT NOT NULL,
    model              TEXT NOT NULL,
    kind               TEXT NOT NULL,
    project_key        TEXT,
    input_tokens       INTEGER NOT NULL,
    output_tokens      INTEGER NOT NULL,
    cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    cost_micro_usd     INTEGER
  );
  CREATE INDEX model_usage_at ON model_usage(at);
  `,
  `
  -- Who wrote each summary, the order digests were saved in, and the page version.
  ALTER TABLE digests ADD COLUMN written_by TEXT;             -- the computer's token label; NULL = the server
  ALTER TABLE digests ADD COLUMN summary_to_follow INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE digests ADD COLUMN saved_seq INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE project_states ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE project_states ADD COLUMN digests_through INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE project_states ADD COLUMN written_by TEXT;
  -- Pages the server owes because it wrote a fallback digest for the project.
  CREATE TABLE server_page_queue (project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE);
  `,
  `
  -- The state pages a computer's last full sync left unwritten, and why. Replaced on each report.
  CREATE TABLE page_skips (
    token_id     INTEGER NOT NULL,
    project_key  TEXT NOT NULL,
    reason       TEXT NOT NULL,
    at           TEXT NOT NULL,
    PRIMARY KEY (token_id, project_key)
  );
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
