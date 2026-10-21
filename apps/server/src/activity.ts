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

/** Like logActivity, but a failure is written to the server log and swallowed: logging must never fail a request. */
export function logActivitySafe(db: Db, e: ActivityEntry, now: string, log: (line: string) => void = console.error): void {
  try {
    logActivity(db, e, now);
  } catch (err) {
    log(`activity log failed: ${err instanceof Error ? err.message : String(err)}`);
  }
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

/** How many rows a listing would have, so the Activity page knows its last page. */
export function countActivity(db: Db, opts: { direction?: Direction } = {}): number {
  const where = opts.direction ? 'WHERE direction = ?' : '';
  const args: string[] = opts.direction ? [opts.direction] : [];
  return (db.prepare(`SELECT COUNT(*) AS n FROM activity ${where}`).get(...args) as { n: number }).n;
}

export function forgetActivityForSession(db: Db, sessionRef: string): void {
  db.prepare('DELETE FROM activity WHERE session_ref = ?').run(sessionRef);
}

export function forgetActivityForProject(db: Db, projectKey: string): void {
  db.prepare('DELETE FROM activity WHERE project_key = ?').run(projectKey);
}

export interface PageLeft {
  project: string;
  reason: string;
}

/**
 * Store a run the collector reported, and show it in the activity log. `pagesLeft`, when the run
 * sent it, replaces the pages this computer last said it left.
 */
export function recordSyncRun(
  db: Db,
  r: { tokenId: number; finishedAt: string; uploaded: number; unchanged: number; errors: number; pagesLeft?: PageLeft[] },
  now: string,
): void {
  db.transaction(() => {
    db.prepare(
      'INSERT INTO sync_runs(token_id, finished_at, uploaded, unchanged, errors, received_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(r.tokenId, r.finishedAt, r.uploaded, r.unchanged, r.errors, now);
    if (r.pagesLeft !== undefined) {
      db.prepare('DELETE FROM page_skips WHERE token_id = ?').run(r.tokenId);
      const insert = db.prepare(
        'INSERT INTO page_skips(token_id, project_key, reason, at) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET reason = excluded.reason',
      );
      for (const p of r.pagesLeft) insert.run(r.tokenId, p.project, p.reason, r.finishedAt);
    }
    const token = db.prepare('SELECT label FROM tokens WHERE id = ?').get(r.tokenId) as { label: string } | undefined;
    const actor = token ? token.label : 'a computer';
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
