import { latestSyncRun, type SyncRun } from '../activity.js';
import type { Db } from '../db.js';
import { readBackupStatus, type BackupStatus } from './backup-status.js';
import { addDays, spendBetween, utcDayStart, type Spend } from '../usage.js';
import type { WebConfig } from './routes.js';

/** One line in the Problems box, or in the notices below it. `at` is a time to show after the text. */
export interface Problem {
  kind: string;
  text: string;
  /** The session id or project key the line is about, where there is one. */
  ref?: string;
  at?: string;
}

export interface Health {
  healthy: boolean;
  problems: Problem[];
  notices: Problem[];
  cards: {
    projects: number;
    sessions: number;
    lastSync: SyncRun | null;
    lastBackup: BackupStatus | null;
    /** Model spend for the current UTC day and for the last 30 days (today included). */
    spend: { today: Spend; month: Spend };
  };
}

/** Spec section 3.2: a summary queued this long with summaries on means the queue is backing up. */
const PENDING_SLOW_MS = 60 * 60_000;
/** No sync run reported for this long means syncing has gone quiet. */
export const SYNC_QUIET_MS = 3 * 24 * 60 * 60_000;
/** No backup finished in this long means the backup is missing or late. */
export const BACKUP_LATE_MS = 26 * 60 * 60_000;

/** Milliseconds from `then` to `now`, or null when either is not a time we can read. */
function since(now: string, then: string): number | null {
  const a = Date.parse(now);
  const b = Date.parse(then);
  return Number.isFinite(a) && Number.isFinite(b) ? a - b : null;
}

const olderThan = (now: string, then: string, ms: number): boolean => {
  const age = since(now, then);
  return age !== null && age > ms;
};

const count = (db: Db, table: string): number => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

interface DigestLine {
  ref: string;
  project: string;
  error: string | null;
  next_attempt_at: string | null;
}

const digestLines = (db: Db, status: 'failed' | 'refused'): DigestLine[] =>
  db
    .prepare(
      `SELECT s.source || ':' || s.source_session_id AS ref, p.key AS project, d.error, d.next_attempt_at
       FROM digests d JOIN sessions s ON s.id = d.session_id JOIN projects p ON p.id = s.project_id
       WHERE d.status = ? ORDER BY s.id`,
    )
    .all(status) as DigestLine[];

const reason = (error: string | null): string => error ?? 'no reason was recorded';

/**
 * Everything the Overview page says about the hub's health, read from the database, the backup
 * status file and the config. All time comparisons use `now`, so the page is testable and the
 * clock the server was given is the only one that counts.
 */
export function computeHealth(db: Db, cfg: WebConfig, now: string): Health {
  const problems: Problem[] = [];

  // Each failed summary, still retrying: the session, its project, the stored reason and the next try.
  for (const d of digestLines(db, 'failed')) {
    problems.push({
      kind: 'digest-failed',
      ref: d.ref,
      text: `Summary failed for ${d.ref} in ${d.project}: ${reason(d.error)}. Next attempt`,
      ...(d.next_attempt_at === null ? {} : { at: d.next_attempt_at }),
    });
  }

  // Each project page waiting to be rebuilt after a failure.
  const retries = db
    .prepare(
      `SELECT p.key AS project, r.error, r.next_attempt_at FROM state_retries r JOIN projects p ON p.id = r.project_id
       ORDER BY r.project_id`,
    )
    .all() as { project: string; error: string | null; next_attempt_at: string }[];
  for (const r of retries) {
    problems.push({
      kind: 'state-retry',
      ref: r.project,
      text: `The project page for ${r.project} could not be rebuilt: ${reason(r.error)}. Next attempt`,
      at: r.next_attempt_at,
    });
  }

  const pending = db.prepare("SELECT updated_at FROM digests WHERE status = 'pending' ORDER BY updated_at").all() as { updated_at: string }[];
  if (!cfg.digestsOn) {
    // Only worth saying while something is waiting: with nothing queued, no key costs nothing.
    if (pending.length > 0) {
      problems.push({
        kind: 'digests-off',
        text: 'Summaries are off: the server has no model key, so new sessions are not being summarised.',
      });
    }
  } else if (pending.some((p) => olderThan(now, p.updated_at, PENDING_SLOW_MS))) {
    problems.push({
      kind: 'digests-backing-up',
      text: 'Summaries are backing up: a summary has been waiting for more than an hour.',
    });
  }

  const lastSync = latestSyncRun(db);
  if (lastSync === null) {
    // A hub that has only just started has had no chance to hear from the PC yet.
    if (olderThan(now, cfg.startedAt, SYNC_QUIET_MS)) {
      problems.push({ kind: 'sync-quiet', text: 'Sync is quiet: no sync run has ever been reported.' });
    }
  } else if (lastSync.errors > 0) {
    problems.push({
      kind: 'sync-failing',
      text: `Sync is failing: the last reported run ended with ${lastSync.errors} error${lastSync.errors === 1 ? '' : 's'}, at`,
      at: lastSync.finishedAt,
    });
  } else if (olderThan(now, lastSync.finishedAt, SYNC_QUIET_MS)) {
    problems.push({
      kind: 'sync-quiet',
      text: 'Sync is quiet: no sync run has been reported for more than three days. The last one finished',
      at: lastSync.finishedAt,
    });
  }

  const lastBackup = readBackupStatus(cfg.backupStatusPath);
  if (lastBackup === null) {
    // Missing is not a failure until a nightly run should have written the file.
    if (olderThan(now, cfg.startedAt, BACKUP_LATE_MS)) {
      problems.push({ kind: 'backup-missing', text: 'No backup status has been written since this server started.' });
    }
  } else {
    if (olderThan(now, lastBackup.finished_at, BACKUP_LATE_MS)) {
      problems.push({
        kind: 'backup-late',
        text: 'The backup is late: the last run finished more than 26 hours ago, at',
        at: lastBackup.finished_at,
      });
    }
    if (!lastBackup.local_ok) {
      problems.push({ kind: 'backup-failed', text: 'The last backup run failed. It finished', at: lastBackup.finished_at });
    }
    if (lastBackup.offsite_configured && lastBackup.offsite_ok === false) {
      problems.push({
        kind: 'backup-offsite',
        text: 'The last backup did not reach off-site storage. It finished',
        at: lastBackup.finished_at,
      });
    }
  }

  // Refused summaries are shown but never counted: nothing on the page can clear them, and a
  // status that never goes green teaches the owner to ignore it (spec 3.2).
  const notices: Problem[] = digestLines(db, 'refused').map((d) => ({
    kind: 'digest-refused',
    ref: d.ref,
    text: `Summary refused for ${d.ref} in ${d.project}: ${reason(d.error)}`,
  }));

  return {
    healthy: problems.length === 0,
    problems,
    notices,
    cards: {
      projects: count(db, 'projects'),
      sessions: (db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE source <> 'doc'").get() as { n: number }).n,
      lastSync,
      lastBackup,
      spend: {
        today: spendBetween(db, utcDayStart(now), addDays(utcDayStart(now), 1)),
        month: spendBetween(db, addDays(utcDayStart(now), -29), addDays(utcDayStart(now), 1)),
      },
    },
  };
}
