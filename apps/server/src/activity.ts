import type { Db } from './db.js';

export type Direction = 'in' | 'out';
export type Action = 'upload' | 'delete' | 'note' | 'sync' | 'list_projects' | 'get_project' | 'search' | 'get_session';

export interface ActivityEntry {
  direction: Direction;
  action: Action;
  projectKey: string | null;
  sessionRef: string | null;
  actor: string;
  detail: string | null;
}

export interface ActivityRow extends ActivityEntry {
  id: number;
  at: string;
}

export interface SyncRun {
  id: number;
  tokenId: number;
  finishedAt: string;
  uploaded: number;
  unchanged: number;
  errors: number;
  receivedAt: string;
}

const KEEP_MS = 30 * 24 * 60 * 60 * 1000;

/** Record one event and drop anything older than 30 days. */
export function logActivity(db: Db, e: ActivityEntry, now: string): void {
  const cutoff = new Date(Date.parse(now) - KEEP_MS).toISOString();
  db.transaction(() => {
    db.prepare('DELETE FROM activity WHERE at < ?').run(cutoff);
    db.prepare(
      'INSERT INTO activity(at, direction, action, project_key, session_ref, actor, detail) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(now, e.direction, e.action, e.projectKey, e.sessionRef, e.actor, e.detail);
  })();
}

/** Newest first. */
export function listActivity(db: Db, opts: { direction?: Direction; limit: number; offset: number }): ActivityRow[] {
  const where = opts.direction ? 'WHERE direction = ?' : '';
  const args: (string | number)[] = opts.direction ? [opts.direction] : [];
  return db
    .prepare(
      `SELECT id, at, direction, action, project_key AS projectKey, session_ref AS sessionRef, actor, detail
       FROM activity ${where} ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .all(...args, opts.limit, opts.offset) as ActivityRow[];
}

export function forgetActivityForSession(db: Db, sessionRef: string): void {
  db.prepare('DELETE FROM activity WHERE session_ref = ?').run(sessionRef);
}

export function forgetActivityForProject(db: Db, projectKey: string): void {
  db.prepare('DELETE FROM activity WHERE project_key = ?').run(projectKey);
}

/** Store a run the collector reported, and show it in the activity log. */
export function recordSyncRun(
  db: Db,
  r: { tokenId: number; finishedAt: string; uploaded: number; unchanged: number; errors: number },
  now: string,
): void {
  db.transaction(() => {
    db.prepare(
      'INSERT INTO sync_runs(token_id, finished_at, uploaded, unchanged, errors, received_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(r.tokenId, r.finishedAt, r.uploaded, r.unchanged, r.errors, now);
    const token = db.prepare('SELECT label FROM tokens WHERE id = ?').get(r.tokenId) as { label: string } | undefined;
    const actor = token ? `your PC (${token.label})` : 'your PC';
    const detail = `${r.uploaded} uploaded, ${r.unchanged} unchanged${r.errors > 0 ? `, ${r.errors} errors` : ''}`;
    logActivity(
      db,
      { direction: 'in', action: 'sync', projectKey: null, sessionRef: null, actor, detail },
      now,
    );
  })();
}

/** The most recent run across all tokens. */
export function latestSyncRun(db: Db): SyncRun | null {
  const row = db
    .prepare(
      `SELECT id, token_id AS tokenId, finished_at AS finishedAt, uploaded, unchanged, errors, received_at AS receivedAt
       FROM sync_runs ORDER BY finished_at DESC, id DESC LIMIT 1`,
    )
    .get() as SyncRun | undefined;
  return row ?? null;
}
