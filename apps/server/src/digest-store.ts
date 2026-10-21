import { renderDigest, type DigestBody, type DigestItem, type UploadDigest } from '@context-hub/core';
import type { Db } from './db.js';
import { deleteDigestRow, searchRowWriter } from './search-rows.js';

export type { DigestBody, DigestItem };

export type DigestStatus = 'pending' | 'ok' | 'failed' | 'refused';

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
  written_by: string | null;
  summary_to_follow: number;
  saved_seq: number;
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
       WHERE s.parent IS NULL AND s.source <> 'doc' AND d.summary_to_follow = 0 AND (d.status = 'pending' OR (d.status = 'failed' AND d.next_attempt_at <= ?))
       ORDER BY s.last_activity_at ASC, s.id ASC
       LIMIT 1`,
    )
    .get(now) as DueDigest | undefined;
  return row ?? null;
}

/** True when another main session of this project is still due for a digest. */
export function projectHasDueDigest(db: Db, projectId: number, now: string): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM digests d JOIN sessions s ON s.id = d.session_id
         WHERE s.project_id = ? AND s.parent IS NULL AND s.source <> 'doc' AND d.summary_to_follow = 0 AND (d.status = 'pending' OR (d.status = 'failed' AND d.next_attempt_at <= ?))
         LIMIT 1`,
      )
      .get(projectId, now) !== undefined
  );
}

export function saveDigest(
  db: Db,
  args: { sessionRowId: number; hash: string; model: string; body: DigestBody; text: string; now: string; writtenBy?: string | null },
): boolean {
  return db.transaction((): boolean => {
    const session = db.prepare('SELECT content_hash FROM sessions WHERE id = ?').get(args.sessionRowId) as { content_hash: string } | undefined;
    // The session was uploaded again (or deleted) while the digest was being written.
    if (!session || session.content_hash !== args.hash) return false;
    db.prepare(
      `UPDATE digests SET status = 'ok', source_hash = ?, model = ?, body = ?, text = ?, attempts = 0,
                          next_attempt_at = NULL, error = NULL, updated_at = ?, written_by = ?, summary_to_follow = 0,
                          saved_seq = (SELECT COALESCE(MAX(saved_seq), 0) + 1 FROM digests)
       WHERE session_id = ?`,
    ).run(args.hash, args.model, JSON.stringify(args.body), args.text, args.now, args.writtenBy ?? null, args.sessionRowId);
    deleteDigestRow(db, args.sessionRowId);
    searchRowWriter(db)(args.sessionRowId, 'digest', -1, args.text);
    return true;
  })();
}

/** The digest row exists for every main session, but a retry may find it missing. */
function ensureDigestRow(db: Db, sessionRowId: number, now: string): void {
  db.prepare("INSERT INTO digests(session_id, status, attempts, updated_at) VALUES (?, 'pending', 0, ?) ON CONFLICT(session_id) DO NOTHING").run(sessionRowId, now);
}

/**
 * Takes the old summary away because it may hold data that cleaning has since
 * removed, and marks the session as owed one. The project's page is flagged
 * too. The server's fallback leaves the session alone.
 */
export function markSummaryToFollow(db: Db, sessionRowId: number, now: string): void {
  db.transaction(() => {
    ensureDigestRow(db, sessionRowId, now);
    db.prepare(
      `UPDATE digests SET status = 'pending', source_hash = NULL, model = NULL, body = NULL, text = NULL, attempts = 0, next_attempt_at = NULL,
                          error = NULL, summary_to_follow = 1, updated_at = ?
       WHERE session_id = ?`,
    ).run(now, sessionRowId);
    deleteDigestRow(db, sessionRowId);
    const session = db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(sessionRowId) as { project_id: number } | undefined;
    if (session) markStateDirty(db, session.project_id);
  })();
}

/** Saves what a computer sent with a session. False when the session changed since the summary was written. */
export function saveComputerOutcome(db: Db, sessionRowId: number, hash: string, outcome: UploadDigest, writtenBy: string, now: string): boolean {
  if ('summary_to_follow' in outcome) {
    markSummaryToFollow(db, sessionRowId, now);
    return true;
  }
  return db.transaction((): boolean => {
    const session = db.prepare('SELECT content_hash FROM sessions WHERE id = ?').get(sessionRowId) as { content_hash: string } | undefined;
    if (!session || session.content_hash !== hash) return false;
    ensureDigestRow(db, sessionRowId, now);
    if ('body' in outcome) return saveDigest(db, { sessionRowId, hash, model: outcome.model, body: outcome.body, text: renderDigest(outcome.body), now, writtenBy });
    if ('refused' in outcome) {
      db.prepare(
        "UPDATE digests SET status = 'refused', next_attempt_at = NULL, error = ?, model = ?, written_by = ?, summary_to_follow = 0, updated_at = ? WHERE session_id = ?",
      ).run(outcome.refused.slice(0, 500), outcome.model, writtenBy, now, sessionRowId);
      return true;
    }
    // A failed summary shows on the dashboard and the server never retries it.
    db.prepare("UPDATE digests SET status = 'failed', next_attempt_at = NULL, error = ?, written_by = ?, summary_to_follow = 0, updated_at = ? WHERE session_id = ?").run(
      outcome.failed.slice(0, 500),
      writtenBy,
      now,
      sessionRowId,
    );
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
  /** Goes up on every change, so a save made from an older read is refused. */
  version: number;
  /** The newest digest (by saved_seq) the page was built from. */
  digests_through: number;
  /** The computer's token label; null when the server wrote it. */
  written_by: string | null;
}

export function getProjectState(db: Db, projectId: number): ProjectState | null {
  const row = db.prepare('SELECT summary, body, model, updated_at, rebuilt_at, dirty, version, digests_through, written_by FROM project_states WHERE project_id = ?').get(projectId) as
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
       version = project_states.version + 1, summary = excluded.summary, body = excluded.body, model = excluded.model, updated_at = excluded.updated_at, dirty = 0,
       rebuilt_at = CASE WHEN ? THEN excluded.rebuilt_at ELSE project_states.rebuilt_at END`,
  ).run(projectId, page.summary, page.body, page.model, now, now, fullRebuild ? 1 : 0);
}

/**
 * Saves a page only when nobody saved one since the caller read it. baseVersion
 * is the version that was read, or null when there was no page.
 */
export function savePageIfVersion(
  db: Db,
  projectId: number,
  page: { summary: string; body: string; model: string },
  opts: { baseVersion: number | null; through: number; fullRebuild: boolean; writtenBy: string | null; now: string },
): { ok: true; version: number } | { ok: false; version: number | null } {
  return db.transaction((): { ok: true; version: number } | { ok: false; version: number | null } => {
    const row = db.prepare('SELECT version FROM project_states WHERE project_id = ?').get(projectId) as { version: number } | undefined;
    if ((row?.version ?? null) !== opts.baseVersion) return { ok: false, version: row?.version ?? null };
    if (!row) {
      db.prepare(
        `INSERT INTO project_states(project_id, summary, body, model, updated_at, rebuilt_at, dirty, version, digests_through, written_by)
         VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?)`,
      ).run(projectId, page.summary, page.body, page.model, opts.now, opts.now, opts.through, opts.writtenBy);
      return { ok: true, version: 1 };
    }
    const full = opts.fullRebuild ? 1 : 0;
    db.prepare(
      `UPDATE project_states SET summary = ?, body = ?, model = ?, updated_at = ?, version = version + 1, digests_through = ?, written_by = ?,
                                 dirty = CASE WHEN ? THEN 0 ELSE dirty END, rebuilt_at = CASE WHEN ? THEN ? ELSE rebuilt_at END
       WHERE project_id = ?`,
    ).run(page.summary, page.body, page.model, opts.now, opts.through, opts.writtenBy, full, full, opts.now, projectId);
    return { ok: true, version: row.version + 1 };
  })();
}

export function deleteProjectState(db: Db, projectId: number): void {
  db.prepare('DELETE FROM project_states WHERE project_id = ?').run(projectId);
}

export function markStateDirty(db: Db, projectId: number): void {
  db.prepare('UPDATE project_states SET dirty = 1, version = version + 1 WHERE project_id = ?').run(projectId);
}

/** Records a failed attempt to write a project's state page and schedules the next one. */
export function failState(db: Db, projectId: number, error: string, now: string): { attempts: number; next_attempt_at: string } {
  const prev = (db.prepare('SELECT attempts FROM state_retries WHERE project_id = ?').get(projectId) as { attempts: number } | undefined)?.attempts ?? 0;
  const attempts = prev + 1;
  const next = new Date(Date.parse(now) + (RETRY_DELAYS_MS[attempts - 1] ?? DAILY_RETRY_MS)).toISOString();
  db.prepare(
    `INSERT INTO state_retries(project_id, attempts, next_attempt_at, error) VALUES (?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET attempts = excluded.attempts, next_attempt_at = excluded.next_attempt_at, error = excluded.error`,
  ).run(projectId, attempts, next, error.slice(0, 500));
  return { attempts, next_attempt_at: next };
}

export function clearStateRetry(db: Db, projectId: number): void {
  db.prepare('DELETE FROM state_retries WHERE project_id = ?').run(projectId);
}

/** True while a project is waiting out a failed state-page attempt. */
export function stateIsWaiting(db: Db, projectId: number, now: string): boolean {
  return db.prepare('SELECT 1 FROM state_retries WHERE project_id = ? AND next_attempt_at > ?').get(projectId, now) !== undefined;
}

/** With `now`, projects still waiting out a failed attempt are left out. */
export function nextProjectNeedingState(db: Db, now?: string): number | null {
  const rows = db
    .prepare(
      `SELECT p.id FROM projects p
       LEFT JOIN project_states ps ON ps.project_id = p.id
       WHERE ps.dirty = 1
          OR (ps.project_id IS NULL AND EXISTS (
                SELECT 1 FROM digests d JOIN sessions s ON s.id = d.session_id
                WHERE s.project_id = p.id AND s.parent IS NULL AND d.status = 'ok'))
       ORDER BY p.id`,
    )
    .all() as { id: number }[];
  const ready = now === undefined ? rows : rows.filter((r) => !stateIsWaiting(db, r.id, now));
  return ready[0]?.id ?? null;
}

/**
 * Projects whose page is flagged dirty, is missing, or lacks a digest saved
 * after the one it was built from. A computer's next sync brings them up to date.
 */
export function projectsNeedingPage(db: Db): string[] {
  const rows = db
    .prepare(
      `SELECT p.key FROM projects p LEFT JOIN project_states ps ON ps.project_id = p.id
       WHERE ps.dirty = 1
          OR EXISTS (SELECT 1 FROM digests d JOIN sessions s ON s.id = d.session_id
                     WHERE s.project_id = p.id AND s.parent IS NULL AND d.status = 'ok' AND d.text IS NOT NULL
                       AND (ps.project_id IS NULL OR d.saved_seq > ps.digests_through))
       ORDER BY p.key`,
    )
    .all() as { key: string }[];
  return rows.map((r) => r.key);
}

/**
 * The projects of projectsNeedingPage, each with when its page fell behind: the save time of the
 * oldest summary it has not taken in. Null for a page that is only flagged dirty.
 */
export function pagesBehind(db: Db): { key: string; since: string | null }[] {
  return db
    .prepare(
      `SELECT p.key,
              (SELECT MIN(d.updated_at) FROM digests d JOIN sessions s ON s.id = d.session_id
               WHERE s.project_id = p.id AND s.parent IS NULL AND d.status = 'ok' AND d.text IS NOT NULL
                 AND (ps.project_id IS NULL OR d.saved_seq > ps.digests_through)) AS since
       FROM projects p LEFT JOIN project_states ps ON ps.project_id = p.id
       WHERE ps.dirty = 1
          OR EXISTS (SELECT 1 FROM digests d JOIN sessions s ON s.id = d.session_id
                     WHERE s.project_id = p.id AND s.parent IS NULL AND d.status = 'ok' AND d.text IS NOT NULL
                       AND (ps.project_id IS NULL OR d.saved_seq > ps.digests_through))
       ORDER BY p.key`,
    )
    .all() as { key: string; since: string | null }[];
}

/** Pages the server owes: it wrote a fallback digest for these projects. */
export function queueServerPage(db: Db, projectId: number): void {
  db.prepare('INSERT INTO server_page_queue(project_id) VALUES (?) ON CONFLICT DO NOTHING').run(projectId);
}

export function unqueueServerPage(db: Db, projectId: number): void {
  db.prepare('DELETE FROM server_page_queue WHERE project_id = ?').run(projectId);
}

/** The next queued project that is not waiting out a failed attempt. */
export function nextServerPage(db: Db, now: string): number | null {
  const rows = db.prepare('SELECT project_id FROM server_page_queue ORDER BY project_id').all() as { project_id: number }[];
  return rows.find((r) => !stateIsWaiting(db, r.project_id, now))?.project_id ?? null;
}

export function okDigestsForProject(
  db: Db,
  projectId: number,
): { session_id: string; title: string; last_activity_at: string | null; text: string; saved_seq: number }[] {
  const rows = db
    .prepare(
      `SELECT s.source, s.source_session_id, s.title, s.last_activity_at, d.text, d.saved_seq
       FROM digests d JOIN sessions s ON s.id = d.session_id
       WHERE s.project_id = ? AND s.parent IS NULL AND d.status = 'ok' AND d.text IS NOT NULL
       ORDER BY s.last_activity_at ASC, s.id ASC`,
    )
    .all(projectId) as { source: string; source_session_id: string; title: string; last_activity_at: string | null; text: string; saved_seq: number }[];
  return rows.map((r) => ({ session_id: `${r.source}:${r.source_session_id}`, title: r.title, last_activity_at: r.last_activity_at, text: r.text, saved_seq: r.saved_seq }));
}

export interface PageInputsResult {
  page: { summary: string; body: string; version: number; rebuilt_at: string; dirty: boolean; digests_through: number } | null;
  /** Every ok digest of the project, oldest first. */
  digests: { session_id: string; title: string; date: string | null; text: string; saved_seq: number }[];
  /** The newest saved_seq among the digests, or 0. A page saved with it covers all of them. */
  through: number;
}

/** What a computer needs to write a project's state page. */
export function pageInputs(db: Db, projectId: number): PageInputsResult {
  const state = getProjectState(db, projectId);
  const digests = okDigestsForProject(db, projectId).map((d) => ({ session_id: d.session_id, title: d.title, date: d.last_activity_at, text: d.text, saved_seq: d.saved_seq }));
  return {
    page: state
      ? { summary: state.summary, body: state.body, version: state.version, rebuilt_at: state.rebuilt_at, dirty: state.dirty, digests_through: state.digests_through }
      : null,
    digests,
    through: Math.max(0, ...digests.map((d) => d.saved_seq)),
  };
}
