import type { HashedSession } from '@context-hub/core';
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
