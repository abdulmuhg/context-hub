import type { Db } from './db.js';

export type DigestStatus = 'pending' | 'ok' | 'failed' | 'refused';

export interface DigestItem {
  text: string;
  /** Position of the message that supports this item, when the model gave one. */
  seq: number | null;
}

export interface DigestBody {
  goal: string;
  done: DigestItem[];
  decisions: { what: string; why: string; seq: number | null }[];
  open_items: DigestItem[];
  key_refs: string[];
}

export interface DigestRow {
  session_id: number;
  status: DigestStatus;
  source_hash: string | null;
  model: string | null;
  body: DigestBody | null;
  text: string | null;
  attempts: number;
  next_attempt_at: string | null;
  error: string | null;
  updated_at: string;
}

export interface DueDigest {
  session_id: number;
  source: string;
  source_session_id: string;
  title: string;
  content_hash: string;
  project_id: number;
  project_key: string;
}

export const RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000, 7_200_000];
export const DAILY_RETRY_MS = 24 * 60 * 60_000;

/** Queues a session. An earlier digest's text is kept until the new one replaces it. */
export function markDigestPending(db: Db, sessionRowId: number, now: string): void {
  db.prepare(
    `INSERT INTO digests(session_id, status, attempts, next_attempt_at, error, updated_at)
     VALUES (?, 'pending', 0, NULL, NULL, ?)
     ON CONFLICT(session_id) DO UPDATE SET status = 'pending', attempts = 0, next_attempt_at = NULL, error = NULL, updated_at = excluded.updated_at`,
  ).run(sessionRowId, now);
}

export function nextDueDigest(db: Db, now: string): DueDigest | null {
  const row = db
    .prepare(
      `SELECT d.session_id, s.source, s.source_session_id, s.title, s.content_hash, s.project_id, p.key AS project_key
       FROM digests d JOIN sessions s ON s.id = d.session_id JOIN projects p ON p.id = s.project_id
       WHERE d.status = 'pending' OR (d.status = 'failed' AND d.next_attempt_at <= ?)
       ORDER BY s.last_activity_at ASC, s.id ASC
       LIMIT 1`,
    )
    .get(now) as DueDigest | undefined;
  return row ?? null;
}

export function saveDigest(
  db: Db,
  args: { sessionRowId: number; hash: string; model: string; body: DigestBody; text: string; now: string },
): boolean {
  return db.transaction((): boolean => {
    const session = db.prepare('SELECT content_hash FROM sessions WHERE id = ?').get(args.sessionRowId) as { content_hash: string } | undefined;
    // The session was uploaded again (or deleted) while the digest was being written.
    if (!session || session.content_hash !== args.hash) return false;
    db.prepare(
      `UPDATE digests SET status = 'ok', source_hash = ?, model = ?, body = ?, text = ?, attempts = 0,
                          next_attempt_at = NULL, error = NULL, updated_at = ?
       WHERE session_id = ?`,
    ).run(args.hash, args.model, JSON.stringify(args.body), args.text, args.now, args.sessionRowId);
    db.prepare("DELETE FROM search_index WHERE session_id = ? AND kind = 'digest'").run(args.sessionRowId);
    db.prepare("INSERT INTO search_index(body, kind, session_id, seq) VALUES (?, 'digest', ?, -1)").run(args.text, args.sessionRowId);
    return true;
  })();
}

export function failDigest(db: Db, sessionRowId: number, error: string, now: string): { attempts: number; next_attempt_at: string } {
  const prev = (db.prepare('SELECT attempts FROM digests WHERE session_id = ?').get(sessionRowId) as { attempts: number } | undefined)?.attempts ?? 0;
  const attempts = prev + 1;
  const wait = RETRY_DELAYS_MS[attempts - 1] ?? DAILY_RETRY_MS;
  const next = new Date(Date.parse(now) + wait).toISOString();
  db.prepare("UPDATE digests SET status = 'failed', attempts = ?, next_attempt_at = ?, error = ?, updated_at = ? WHERE session_id = ?").run(
    attempts,
    next,
    error.slice(0, 500),
    now,
    sessionRowId,
  );
  return { attempts, next_attempt_at: next };
}

export function refuseDigest(db: Db, sessionRowId: number, reason: string, now: string): void {
  db.prepare("UPDATE digests SET status = 'refused', next_attempt_at = NULL, error = ?, updated_at = ? WHERE session_id = ?").run(reason.slice(0, 500), now, sessionRowId);
}

export function getDigest(db: Db, sessionRowId: number): DigestRow | null {
  const row = db.prepare('SELECT * FROM digests WHERE session_id = ?').get(sessionRowId) as (Omit<DigestRow, 'body'> & { body: string | null }) | undefined;
  if (!row) return null;
  return { ...row, body: row.body === null ? null : (JSON.parse(row.body) as DigestBody) };
}

export function digestCounts(db: Db): Record<DigestStatus, number> {
  const counts: Record<DigestStatus, number> = { pending: 0, ok: 0, failed: 0, refused: 0 };
  for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM digests GROUP BY status').all() as { status: DigestStatus; n: number }[]) {
    counts[r.status] = r.n;
  }
  return counts;
}

export interface ProjectState {
  /** One sentence. Shown by list_projects. */
  summary: string;
  body: string;
  model: string;
  updated_at: string;
  /** When the page was last rebuilt from all digests, as opposed to merged. */
  rebuilt_at: string;
  /** True when a session was removed or moved away, so the page may describe work that is gone. */
  dirty: boolean;
}

export function getProjectState(db: Db, projectId: number): ProjectState | null {
  const row = db.prepare('SELECT summary, body, model, updated_at, rebuilt_at, dirty FROM project_states WHERE project_id = ?').get(projectId) as
    | (Omit<ProjectState, 'dirty'> & { dirty: number })
    | undefined;
  return row ? { ...row, dirty: row.dirty === 1 } : null;
}

export function saveProjectState(
  db: Db,
  projectId: number,
  page: { summary: string; body: string; model: string },
  now: string,
  fullRebuild: boolean,
): void {
  db.prepare(
    `INSERT INTO project_states(project_id, summary, body, model, updated_at, rebuilt_at, dirty)
     VALUES (?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(project_id) DO UPDATE SET
       summary = excluded.summary, body = excluded.body, model = excluded.model, updated_at = excluded.updated_at, dirty = 0,
       rebuilt_at = CASE WHEN ? THEN excluded.rebuilt_at ELSE project_states.rebuilt_at END`,
  ).run(projectId, page.summary, page.body, page.model, now, now, fullRebuild ? 1 : 0);
}

export function deleteProjectState(db: Db, projectId: number): void {
  db.prepare('DELETE FROM project_states WHERE project_id = ?').run(projectId);
}

export function markStateDirty(db: Db, projectId: number): void {
  db.prepare('UPDATE project_states SET dirty = 1 WHERE project_id = ?').run(projectId);
}

export function nextProjectNeedingState(db: Db): number | null {
  const row = db
    .prepare(
      `SELECT p.id FROM projects p
       LEFT JOIN project_states ps ON ps.project_id = p.id
       WHERE ps.dirty = 1
          OR (ps.project_id IS NULL AND EXISTS (
                SELECT 1 FROM digests d JOIN sessions s ON s.id = d.session_id
                WHERE s.project_id = p.id AND d.status = 'ok'))
       ORDER BY p.id LIMIT 1`,
    )
    .get() as { id: number } | undefined;
  return row?.id ?? null;
}

export function okDigestsForProject(db: Db, projectId: number): { session_id: string; title: string; last_activity_at: string | null; text: string }[] {
  const rows = db
    .prepare(
      `SELECT s.source, s.source_session_id, s.title, s.last_activity_at, d.text
       FROM digests d JOIN sessions s ON s.id = d.session_id
       WHERE s.project_id = ? AND s.parent IS NULL AND d.status = 'ok' AND d.text IS NOT NULL
       ORDER BY s.last_activity_at ASC, s.id ASC`,
    )
    .all(projectId) as { source: string; source_session_id: string; title: string; last_activity_at: string | null; text: string }[];
  return rows.map((r) => ({ session_id: `${r.source}:${r.source_session_id}`, title: r.title, last_activity_at: r.last_activity_at, text: r.text }));
}
