import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db.js';
import { failDigest, failState, markDigestPending, refuseDigest } from '../src/digest-store.js';
import { readBackupStatus, type BackupStatus } from '../src/web/backup-status.js';
import { recordUsage } from '../src/usage.js';
import { computeHealth } from '../src/web/health.js';
import type { WebConfig } from '../src/web/routes.js';

const NOW = '2026-10-20T12:00:00.000Z';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.parse(NOW) - ms).toISOString();

let db: Db;
let dir: string;
let statusPath: string;

/** Inserts a project and a session row directly, as the digest-store tests do. */
function addSession(id: string, project = 'local:alpha'): number {
  db.prepare('INSERT INTO projects(key, name, created_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING').run(project, project, ago(DAY));
  const projectId = (db.prepare('SELECT id FROM projects WHERE key = ?').get(project) as { id: number }).id;
  const info = db
    .prepare(
      `INSERT INTO sessions(source, source_session_id, project_id, parent, title, last_activity_at, content_hash, synced_at)
       VALUES ('claude-code', ?, ?, NULL, ?, ?, 'h1', ?)`,
    )
    .run(id, projectId, `title ${id}`, ago(DAY), ago(DAY));
  return Number(info.lastInsertRowid);
}

const projectId = (key = 'local:alpha') => (db.prepare('SELECT id FROM projects WHERE key = ?').get(key) as { id: number }).id;

const addSyncRun = (over: { finishedAt?: string; uploaded?: number; errors?: number } = {}): void => {
  db.prepare('INSERT INTO sync_runs(token_id, finished_at, uploaded, unchanged, errors, received_at) VALUES (1, ?, ?, 205, ?, ?)').run(
    over.finishedAt ?? ago(HOUR),
    over.uploaded ?? 2,
    over.errors ?? 0,
    over.finishedAt ?? ago(HOUR),
  );
};

const GOOD_STATUS: BackupStatus = {
  finished_at: ago(2 * HOUR),
  local_ok: true,
  size_bytes: 1024,
  offsite_configured: true,
  offsite_ok: true,
};

const writeStatus = (over: Partial<BackupStatus> = {}): void => {
  writeFileSync(statusPath, JSON.stringify({ ...GOOD_STATUS, ...over }), 'utf8');
};

const cfg = (over: Partial<WebConfig> = {}): WebConfig => ({
  imageTag: 'abc1234',
  startedAt: ago(HOUR),
  digestsOn: true,
  backupStatusPath: statusPath,
  secureCookies: false,
  publicOrigin: null,
  dailyBudgetUsd: null,
  ...over,
});

/**
 * The healthy starting point every rule's test changes one thing in: one summarised session, one
 * summary queued ten minutes ago, a clean sync run an hour old and a fresh backup status.
 */
beforeEach(() => {
  db = openDb(':memory:');
  dir = mkdtempSync(join(tmpdir(), 'hub-backup-'));
  statusPath = join(dir, 'context-hub.json');
  const done = addSession('ok1');
  markDigestPending(db, done, ago(DAY));
  db.prepare("UPDATE digests SET status = 'ok', text = 'x' WHERE session_id = ?").run(done);
  markDigestPending(db, addSession('pend'), ago(10 * 60_000));
  addSyncRun();
  writeStatus();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const kinds = (h: ReturnType<typeof computeHealth>) => h.problems.map((p) => p.kind);

describe('the healthy fixture', () => {
  it('reports no problems and fills the cards', () => {
    const h = computeHealth(db, cfg(), NOW);
    expect(h.problems).toEqual([]);
    expect(h.notices).toEqual([]);
    expect(h.healthy).toBe(true);
    expect(h.cards.projects).toBe(1);
    expect(h.cards.sessions).toBe(2);
    expect(h.cards.lastSync).toMatchObject({ uploaded: 2, errors: 0, finishedAt: ago(HOUR) });
    expect(h.cards.lastBackup).toEqual(GOOD_STATUS);
  });

  it('leaves documents out of the sessions card', () => {
    db.prepare(
      `INSERT INTO sessions(source, source_session_id, project_id, parent, title, last_activity_at, content_hash, synced_at)
       VALUES ('doc', 'local:alpha#kb/INDEX.md', ?, NULL, 'Index', ?, 'h1', ?)`,
    ).run(projectId(), ago(DAY), ago(DAY));
    expect(computeHealth(db, cfg(), NOW).cards.sessions).toBe(2);
  });
});

describe('problem rules', () => {
  it('lists every failed summary with its session, project, reason and next attempt', () => {
    const id = db.prepare("SELECT session_id FROM digests WHERE status = 'pending'").get() as { session_id: number };
    const { next_attempt_at } = failDigest(db, id.session_id, 'the model timed out', NOW);
    const h = computeHealth(db, cfg(), NOW);
    expect(h.healthy).toBe(false);
    expect(kinds(h)).toEqual(['digest-failed']);
    const p = h.problems[0]!;
    expect(p.ref).toBe('claude-code:pend');
    expect(p.text).toContain('claude-code:pend');
    expect(p.text).toContain('local:alpha');
    expect(p.text).toContain('the model timed out');
    expect(p.at).toBe(next_attempt_at);
  });

  it('lists one line per failed summary', () => {
    for (const r of db.prepare('SELECT session_id FROM digests').all() as { session_id: number }[]) {
      failDigest(db, r.session_id, 'boom', NOW);
    }
    expect(kinds(computeHealth(db, cfg(), NOW))).toEqual(['digest-failed', 'digest-failed']);
  });

  it('lists every project page waiting to be rebuilt, with its next attempt', () => {
    const { next_attempt_at } = failState(db, projectId(), 'the page was too long', NOW);
    const h = computeHealth(db, cfg(), NOW);
    expect(h.healthy).toBe(false);
    expect(kinds(h)).toEqual(['state-retry']);
    expect(h.problems[0]!.ref).toBe('local:alpha');
    expect(h.problems[0]!.text).toContain('local:alpha');
    expect(h.problems[0]!.text).toContain('the page was too long');
    expect(h.problems[0]!.at).toBe(next_attempt_at);
  });

  it('says summaries are off when they are off and a summary is queued', () => {
    const h = computeHealth(db, cfg({ digestsOn: false }), NOW);
    expect(h.healthy).toBe(false);
    expect(kinds(h)).toEqual(['digests-off']);
    expect(h.problems[0]!.text).toMatch(/summaries are off/i);
  });

  it('says summaries are backing up when one has been pending for more than an hour', () => {
    db.prepare("UPDATE digests SET updated_at = ? WHERE status = 'pending'").run(ago(2 * HOUR));
    const h = computeHealth(db, cfg(), NOW);
    expect(h.healthy).toBe(false);
    expect(kinds(h)).toEqual(['digests-backing-up']);
    expect(h.problems[0]!.text).toMatch(/backing up/i);
  });

  it('does not also say backing up while the daily limit holds summaries', () => {
    db.prepare("UPDATE digests SET updated_at = ? WHERE status = 'pending'").run(ago(2 * HOUR));
    recordUsage(db, { model: 'claude-haiku-5-5', kind: 'digest', project: 'p', input_tokens: 100_000, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }, ago(HOUR));
    expect(kinds(computeHealth(db, cfg({ dailyBudgetUsd: 0.01 }), NOW))).toEqual(['budget-reached']);
  });

  it('says sync is failing when the last reported run ended with errors', () => {
    db.prepare('UPDATE sync_runs SET errors = 3').run();
    const h = computeHealth(db, cfg(), NOW);
    expect(h.healthy).toBe(false);
    expect(kinds(h)).toEqual(['sync-failing']);
    expect(h.problems[0]!.text).toContain('3');
  });

  it('says sync has gone quiet when the last run is more than three days old', () => {
    db.prepare('UPDATE sync_runs SET finished_at = ?').run(ago(4 * DAY));
    const h = computeHealth(db, cfg(), NOW);
    expect(h.healthy).toBe(false);
    expect(kinds(h)).toEqual(['sync-quiet']);
    expect(h.problems[0]!.at).toBe(ago(4 * DAY));
  });

  it('counts no report at all once the server has been up for more than three days', () => {
    db.prepare('DELETE FROM sync_runs').run();
    // No report and a server that started an hour ago is not yet a problem.
    expect(computeHealth(db, cfg(), NOW).problems).toEqual([]);
    const h = computeHealth(db, cfg({ startedAt: ago(4 * DAY) }), NOW);
    expect(h.healthy).toBe(false);
    expect(kinds(h)).toEqual(['sync-quiet']);
    expect(h.cards.lastSync).toBe(null);
  });

  it('counts a missing backup status only once the server has been up for more than 26 hours', () => {
    // A hub that started an hour ago has simply not seen a backup run yet.
    const young = computeHealth(db, cfg({ backupStatusPath: null }), NOW);
    expect(young.problems).toEqual([]);
    expect(young.cards.lastBackup).toBe(null);
    const h = computeHealth(db, cfg({ backupStatusPath: null, startedAt: ago(30 * HOUR) }), NOW);
    expect(h.healthy).toBe(false);
    expect(kinds(h)).toEqual(['backup-missing']);
  });

  it('says the backup is late when the last one is more than 26 hours old', () => {
    writeStatus({ finished_at: ago(27 * HOUR) });
    const h = computeHealth(db, cfg(), NOW);
    expect(h.healthy).toBe(false);
    expect(kinds(h)).toEqual(['backup-late']);
    expect(h.problems[0]!.at).toBe(ago(27 * HOUR));
  });

  it('says the backup failed when the local run did not succeed', () => {
    writeStatus({ local_ok: false });
    const h = computeHealth(db, cfg(), NOW);
    expect(h.healthy).toBe(false);
    expect(kinds(h)).toEqual(['backup-failed']);
  });

  it('says the backup did not reach off-site storage when off-site storage is configured', () => {
    writeStatus({ offsite_ok: false });
    const h = computeHealth(db, cfg(), NOW);
    expect(h.healthy).toBe(false);
    expect(kinds(h)).toEqual(['backup-offsite']);
    expect(h.problems[0]!.text).toMatch(/off-site/i);
  });

  it('ignores a failed off-site upload when off-site storage is not configured', () => {
    writeStatus({ offsite_configured: false, offsite_ok: null });
    expect(computeHealth(db, cfg(), NOW).problems).toEqual([]);
  });
});

describe('refused summaries', () => {
  it('are a notice, not a problem, and keep the status healthy', () => {
    const id = db.prepare("SELECT session_id FROM digests WHERE status = 'pending'").get() as { session_id: number };
    refuseDigest(db, id.session_id, 'the transcript holds secrets', NOW);
    const h = computeHealth(db, cfg(), NOW);
    expect(h.problems).toEqual([]);
    expect(h.healthy).toBe(true);
    expect(h.notices.map((n) => n.kind)).toEqual(['digest-refused']);
    expect(h.notices[0]!.ref).toBe('claude-code:pend');
    expect(h.notices[0]!.text).toContain('the transcript holds secrets');
  });
});

describe('readBackupStatus', () => {
  it('reads a valid file', () => {
    expect(readBackupStatus(statusPath)).toEqual(GOOD_STATUS);
  });

  it('returns null without a path', () => {
    expect(readBackupStatus(null)).toBe(null);
  });

  it('returns null for a missing file', () => {
    expect(readBackupStatus(join(dir, 'nope.json'))).toBe(null);
  });

  it('returns null for invalid JSON', () => {
    writeFileSync(statusPath, '{not json', 'utf8');
    expect(readBackupStatus(statusPath)).toBe(null);
  });

  it('returns null when a field has the wrong shape', () => {
    for (const bad of [
      { finished_at: 42 },
      { finished_at: 'not a time' },
      { local_ok: 'yes' },
      { size_bytes: 'big' },
      { offsite_configured: null },
      { offsite_ok: 'maybe' },
    ]) {
      writeFileSync(statusPath, JSON.stringify({ ...GOOD_STATUS, ...bad }), 'utf8');
      expect(readBackupStatus(statusPath)).toBe(null);
    }
  });

  it('accepts a null size and an unconfigured off-site target', () => {
    writeStatus({ size_bytes: null, offsite_configured: false, offsite_ok: null });
    expect(readBackupStatus(statusPath)).toMatchObject({ size_bytes: null, offsite_configured: false, offsite_ok: null });
  });
});

describe('the model spend card', () => {
  const call = (at: string, over: Partial<Parameters<typeof recordUsage>[1]> = {}) =>
    recordUsage(db, { model: 'claude-haiku-5-5', kind: 'digest', project: 'p', input_tokens: 10_000, output_tokens: 1_000, cache_read_tokens: 0, cache_write_tokens: 0, ...over }, at);

  it('counts today (UTC) apart from the 30 days, which include today', () => {
    call('2026-10-19T23:59:00.000Z'); // yesterday
    call('2026-10-20T00:00:00.000Z');
    call('2026-10-20T09:00:00.000Z');
    call('2026-09-20T09:00:00.000Z'); // 30 days back: outside the window
    const { spend } = computeHealth(db, cfg(), NOW).cards;
    // 10,000 x $0.10/M + 1,000 x $0.50/M = $0.0015 per call
    expect(spend.today).toMatchObject({ calls: 2, micro_usd: 3000 });
    expect(spend.month).toMatchObject({ calls: 3, micro_usd: 4500 });
  });

  it('is all zeros with no rows', () => {
    const { spend } = computeHealth(db, cfg(), NOW).cards;
    expect(spend.today.calls).toBe(0);
    expect(spend.month.calls).toBe(0);
  });
});

describe('the daily limit', () => {
  const spendMicro = (at: string, input: number) =>
    recordUsage(db, { model: 'claude-haiku-5-5', kind: 'digest', project: 'p', input_tokens: input, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }, at);

  it('shows the paused problem only while the spend of today is at the limit', () => {
    spendMicro('2026-10-20T01:00:00.000Z', 100_000); // $0.01 today
    spendMicro('2026-10-19T01:00:00.000Z', 10_000_000); // a big day yesterday does not count
    expect(computeHealth(db, cfg({ dailyBudgetUsd: 0.02 }), NOW).problems.map((p) => p.kind)).not.toContain('budget-reached');
    const h = computeHealth(db, cfg({ dailyBudgetUsd: 0.01 }), NOW);
    expect(h.healthy).toBe(false);
    expect(h.problems.find((p) => p.kind === 'budget-reached')!.text).toBe(
      "Summaries paused: today's model spend reached the $0.01 daily limit. They resume at 00:00 UTC.",
    );
    expect(computeHealth(db, cfg({ dailyBudgetUsd: 0.01 }), '2026-10-21T00:00:00.000Z').problems.map((p) => p.kind)).not.toContain('budget-reached');
  });

  it('says nothing without a limit', () => {
    spendMicro('2026-10-20T01:00:00.000Z', 100_000_000);
    expect(computeHealth(db, cfg(), NOW).problems).toEqual([]);
  });
});
