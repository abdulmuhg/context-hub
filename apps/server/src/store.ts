import type { HashedSession, Message } from '@context-hub/core';
import type { Db } from './db.js';

export function publicId(source: string, id: string): string {
  return `${source}:${id}`;
}

export function splitPublicId(value: string): { source: string; id: string } | null {
  const i = value.indexOf(':');
  if (i <= 0 || i === value.length - 1) return null;
  return { source: value.slice(0, i), id: value.slice(i + 1) };
}

export function projectName(key: string): string {
  if (key.startsWith('local:')) return key.slice('local:'.length);
  return key.split('/').pop() || key;
}

function removeContent(db: Db, sessionRowId: number): void {
  db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionRowId);
  db.prepare('DELETE FROM search_index WHERE session_id = ?').run(sessionRowId);
}

function pruneEmptyProjects(db: Db): void {
  db.prepare('DELETE FROM projects WHERE id NOT IN (SELECT DISTINCT project_id FROM sessions)').run();
}

export function upsertSession(db: Db, s: HashedSession, now: string): { changed: boolean } {
  return db.transaction((): { changed: boolean } => {
    const existing = db
      .prepare('SELECT id, content_hash FROM sessions WHERE source = ? AND source_session_id = ?')
      .get(s.source, s.source_session_id) as { id: number; content_hash: string } | undefined;
    if (existing && existing.content_hash === s.content_hash) return { changed: false };

    db.prepare('INSERT INTO projects(key, name, created_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING').run(
      s.project_key,
      projectName(s.project_key),
      now,
    );
    const projectId = (db.prepare('SELECT id FROM projects WHERE key = ?').get(s.project_key) as { id: number }).id;

    let rowId: number;
    if (existing) {
      rowId = existing.id;
      removeContent(db, rowId);
      db.prepare(
        `UPDATE sessions SET project_id = ?, account_id = ?, parent = ?, title = ?, cwd = ?, git_branch = ?,
                             started_at = ?, last_activity_at = ?, content_hash = ?, synced_at = ?
         WHERE id = ?`,
      ).run(projectId, s.account_id, s.parent, s.title, s.cwd, s.git_branch, s.started_at, s.last_activity_at, s.content_hash, now, rowId);
    } else {
      const info = db
        .prepare(
          `INSERT INTO sessions(source, source_session_id, project_id, account_id, parent, title, cwd, git_branch,
                                started_at, last_activity_at, content_hash, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(s.source, s.source_session_id, projectId, s.account_id, s.parent, s.title, s.cwd, s.git_branch, s.started_at, s.last_activity_at, s.content_hash, now);
      rowId = Number(info.lastInsertRowid);
    }

    const insertMessage = db.prepare(
      `INSERT INTO messages(session_id, seq, role, kind, ts, text, tool_name, tool_input, tool_result, tool_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const index = db.prepare('INSERT INTO search_index(body, kind, session_id, seq) VALUES (?, ?, ?, ?)');

    index.run(s.title, 'title', rowId, -1);
    for (const m of s.messages) {
      if (m.kind === 'text') {
        insertMessage.run(rowId, m.seq, m.role, m.kind, m.ts, m.text, null, null, null, null);
        index.run(m.text, 'message', rowId, m.seq);
      } else {
        insertMessage.run(rowId, m.seq, m.role, m.kind, m.ts, null, m.tool_name, m.tool_input, m.tool_result, m.tool_status);
        index.run(`${m.tool_name} ${m.tool_input}`, 'tool', rowId, m.seq);
      }
    }

    pruneEmptyProjects(db);
    return { changed: true };
  })();
}

function removeSessions(db: Db, rowIds: number[]): number {
  for (const id of rowIds) {
    removeContent(db, id);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }
  pruneEmptyProjects(db);
  return rowIds.length;
}

export function deleteSession(db: Db, source: string, id: string): number {
  return db.transaction((): number => {
    const rows = db
      .prepare('SELECT id FROM sessions WHERE source = ? AND (source_session_id = ? OR parent = ?)')
      .all(source, id, id) as { id: number }[];
    return removeSessions(db, rows.map((r) => r.id));
  })();
}

export function deleteProject(db: Db, key: string): number {
  return db.transaction((): number => {
    const rows = db
      .prepare('SELECT s.id FROM sessions s JOIN projects p ON p.id = s.project_id WHERE p.key = ?')
      .all(key) as { id: number }[];
    return removeSessions(db, rows.map((r) => r.id));
  })();
}

export interface Status {
  projects: number;
  sessions: number;
  messages: number;
  last_sync: { project: string; last_synced_at: string }[];
}

export function status(db: Db): Status {
  const n = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return {
    projects: n('projects'),
    sessions: n('sessions'),
    messages: n('messages'),
    last_sync: db
      .prepare(
        `SELECT p.key AS project, MAX(s.synced_at) AS last_synced_at
         FROM projects p JOIN sessions s ON s.project_id = p.id GROUP BY p.id ORDER BY p.key`,
      )
      .all() as { project: string; last_synced_at: string }[],
  };
}

export const PAGE_BUDGET = 30000;

export interface ProjectSummary {
  key: string;
  name: string;
  /** Main sessions only. */
  session_count: number;
  last_activity_at: string | null;
  last_synced_at: string;
  /** One-line state. Filled by Part 3. */
  summary: string | null;
}

export function listProjects(db: Db): ProjectSummary[] {
  const rows = db
    .prepare(
      `SELECT p.key, p.name,
              SUM(CASE WHEN s.parent IS NULL THEN 1 ELSE 0 END) AS session_count,
              MAX(s.last_activity_at) AS last_activity_at,
              MAX(s.synced_at) AS last_synced_at
       FROM projects p JOIN sessions s ON s.project_id = p.id
       GROUP BY p.id
       ORDER BY last_activity_at DESC, p.key`,
    )
    .all() as Omit<ProjectSummary, 'summary'>[];
  return rows.map((r) => ({ ...r, summary: null }));
}

export type Resolved = { ok: true; id: number; key: string } | { ok: false; candidates: string[] };

export function resolveProject(db: Db, input: string): Resolved {
  const all = db.prepare('SELECT id, key, name FROM projects ORDER BY key').all() as { id: number; key: string; name: string }[];
  const exact = all.find((p) => p.key === input);
  if (exact) return { ok: true, id: exact.id, key: exact.key };
  const wanted = input.trim().toLowerCase();
  const matches = all.filter((p) => p.key.toLowerCase() === wanted || p.name.toLowerCase() === wanted);
  if (matches.length === 1) return { ok: true, id: matches[0]!.id, key: matches[0]!.key };
  return { ok: false, candidates: (matches.length > 1 ? matches : all).map((p) => p.key) };
}

export interface SessionSummary {
  session_id: string;
  source: string;
  title: string;
  started_at: string | null;
  last_activity_at: string | null;
  git_branch: string | null;
  account_id: string | null;
  is_subagent: boolean;
  /** Filled by Part 3. */
  digest: null;
}

interface SessionRow {
  id: number;
  source: string;
  source_session_id: string;
  title: string;
  started_at: string | null;
  last_activity_at: string | null;
  git_branch: string | null;
  account_id: string | null;
  parent: string | null;
  cwd: string | null;
  synced_at: string;
  project: string;
}

const SESSION_COLUMNS = `s.id, s.source, s.source_session_id, s.title, s.started_at, s.last_activity_at,
                         s.git_branch, s.account_id, s.parent, s.cwd, s.synced_at, p.key AS project`;

function summarise(r: SessionRow): SessionSummary {
  return {
    session_id: publicId(r.source, r.source_session_id),
    source: r.source,
    title: r.title,
    started_at: r.started_at,
    last_activity_at: r.last_activity_at,
    git_branch: r.git_branch,
    account_id: r.account_id,
    is_subagent: r.parent !== null,
    digest: null,
  };
}

export interface ProjectView {
  key: string;
  name: string;
  /** The project state page. Filled by Part 3. */
  state: null;
  last_synced_at: string;
  recent: SessionSummary[];
}

export function getProject(db: Db, projectId: number, sessions: number): ProjectView {
  const project = db.prepare('SELECT key, name FROM projects WHERE id = ?').get(projectId) as { key: string; name: string };
  const synced = db.prepare('SELECT MAX(synced_at) AS t FROM sessions WHERE project_id = ?').get(projectId) as { t: string };
  const rows = db
    .prepare(
      `SELECT ${SESSION_COLUMNS} FROM sessions s JOIN projects p ON p.id = s.project_id
       WHERE s.project_id = ? AND s.parent IS NULL
       ORDER BY s.last_activity_at DESC, s.id DESC LIMIT ?`,
    )
    .all(projectId, sessions) as SessionRow[];
  return { key: project.key, name: project.name, state: null, last_synced_at: synced.t, recent: rows.map(summarise) };
}

export interface SessionPage {
  session: SessionSummary & { project: string; cwd: string | null; message_count: number; last_synced_at: string };
  messages: Message[];
  /** The seq to pass as from_seq for the next page, or null at the end. */
  next_seq: number | null;
}

interface MessageRow {
  seq: number;
  role: 'user' | 'assistant';
  kind: 'text' | 'tool_call';
  ts: string | null;
  text: string | null;
  tool_name: string | null;
  tool_input: string | null;
  tool_result: string | null;
  tool_status: 'ok' | 'error' | null;
}

function toMessage(r: MessageRow): Message {
  if (r.kind === 'text') return { seq: r.seq, role: r.role, kind: 'text', ts: r.ts, text: r.text ?? '' };
  return {
    seq: r.seq,
    role: 'assistant',
    kind: 'tool_call',
    ts: r.ts,
    tool_name: r.tool_name ?? '',
    tool_input: r.tool_input ?? '',
    tool_result: r.tool_result ?? '',
    tool_status: r.tool_status ?? 'ok',
  };
}

function size(m: Message): number {
  return m.kind === 'text' ? m.text.length : m.tool_name.length + m.tool_input.length + m.tool_result.length;
}

export function getSessionPage(db: Db, source: string, id: string, fromSeq: number, budget: number = PAGE_BUDGET): SessionPage | null {
  const row = db
    .prepare(`SELECT ${SESSION_COLUMNS} FROM sessions s JOIN projects p ON p.id = s.project_id WHERE s.source = ? AND s.source_session_id = ?`)
    .get(source, id) as SessionRow | undefined;
  if (!row) return null;
  const total = (db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(row.id) as { n: number }).n;

  const messages: Message[] = [];
  let used = 0;
  let next: number | null = null;
  const rows = db.prepare('SELECT * FROM messages WHERE session_id = ? AND seq >= ? ORDER BY seq').iterate(row.id, fromSeq) as IterableIterator<MessageRow>;
  for (const r of rows) {
    const m = toMessage(r);
    // A page always holds at least one message, so an oversized message cannot stall the reader.
    if (messages.length > 0 && used + size(m) > budget) {
      next = m.seq;
      break;
    }
    messages.push(m);
    used += size(m);
  }

  return {
    session: { ...summarise(row), project: row.project, cwd: row.cwd, message_count: total, last_synced_at: row.synced_at },
    messages,
    next_seq: next,
  };
}
