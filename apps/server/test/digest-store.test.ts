import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, SCHEMA_VERSION, type Db } from '../src/db.js';
import {
  DAILY_RETRY_MS,
  deleteProjectState,
  digestCounts,
  failDigest,
  getDigest,
  getProjectState,
  markDigestPending,
  markStateDirty,
  nextDueDigest,
  markSummaryToFollow,
  nextProjectNeedingState,
  okDigestsForProject,
  projectsNeedingPage,
  refuseDigest,
  RETRY_DELAYS_MS,
  saveDigest,
  savePageIfVersion,
  saveProjectState,
  type DigestBody,
} from '../src/digest-store.js';

const T0 = '2026-10-11T00:00:00.000Z';
const at = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();
const BODY: DigestBody = { goal: 'fix login', done: [{ text: 'patched cookie check', seq: 3 }], decisions: [], open_items: [], key_refs: ['src/auth.ts'] };
let db: Db;

/** Inserts a project and a session row directly, without going through the store. */
function addSession(id: string, over: { project?: string; activity?: string; hash?: string; parent?: string | null } = {}): number {
  const key = over.project ?? 'local:alpha';
  db.prepare('INSERT INTO projects(key, name, created_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING').run(key, key, T0);
  const projectId = (db.prepare('SELECT id FROM projects WHERE key = ?').get(key) as { id: number }).id;
  const info = db
    .prepare(
      `INSERT INTO sessions(source, source_session_id, project_id, parent, title, last_activity_at, content_hash, synced_at)
       VALUES ('claude-code', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, projectId, over.parent ?? null, `title ${id}`, over.activity ?? '2026-10-01T00:00:00.000Z', over.hash ?? 'h1', T0);
  return Number(info.lastInsertRowid);
}
const projectId = (key = 'local:alpha') => (db.prepare('SELECT id FROM projects WHERE key = ?').get(key) as { id: number }).id;

beforeEach(() => {
  db = openDb(':memory:');
});

describe('migration 2', () => {
  it('adds the digest and state tables and bumps the schema version', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(3);
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(['digests', 'project_states']));
  });
});

describe('the digest queue', () => {
  it('a pending digest is due at once, oldest session activity first', () => {
    const newer = addSession('new', { activity: '2026-10-05T00:00:00.000Z' });
    const older = addSession('old', { activity: '2026-10-02T00:00:00.000Z' });
    markDigestPending(db, newer, T0);
    markDigestPending(db, older, T0);
    expect(nextDueDigest(db, T0)).toMatchObject({ session_id: older, source_session_id: 'old', title: 'title old', content_hash: 'h1', project_key: 'local:alpha' });
  });

  it('nothing is due when the queue is empty', () => {
    addSession('a');
    expect(nextDueDigest(db, T0)).toBeNull();
  });

  it('saving marks it ok, stores body, text, model and hash, and indexes the text for search', () => {
    const id = addSession('a');
    markDigestPending(db, id, T0);
    expect(saveDigest(db, { sessionRowId: id, hash: 'h1', model: 'm1', body: BODY, text: 'Goal: fix login', now: at(1000) })).toBe(true);
    expect(getDigest(db, id)).toMatchObject({ status: 'ok', source_hash: 'h1', model: 'm1', body: BODY, text: 'Goal: fix login', attempts: 0, error: null });
    expect(nextDueDigest(db, at(2000))).toBeNull();
    expect(db.prepare("SELECT body, kind, seq FROM search_index WHERE kind = 'digest'").all()).toEqual([{ body: 'Goal: fix login', kind: 'digest', seq: -1 }]);
  });

  it('saving again replaces the search row instead of adding a second one', () => {
    const id = addSession('a');
    markDigestPending(db, id, T0);
    saveDigest(db, { sessionRowId: id, hash: 'h1', model: 'm1', body: BODY, text: 'first', now: T0 });
    saveDigest(db, { sessionRowId: id, hash: 'h1', model: 'm1', body: BODY, text: 'second', now: T0 });
    expect(db.prepare("SELECT body FROM search_index WHERE kind = 'digest'").all()).toEqual([{ body: 'second' }]);
  });

  it('refuses to save when the session changed in the meantime', () => {
    const id = addSession('a', { hash: 'h2' });
    markDigestPending(db, id, T0);
    expect(saveDigest(db, { sessionRowId: id, hash: 'h1', model: 'm1', body: BODY, text: 'stale', now: T0 })).toBe(false);
    expect(getDigest(db, id)).toMatchObject({ status: 'pending', text: null });
  });

  it('marking pending again keeps the old text but resets attempts', () => {
    const id = addSession('a');
    markDigestPending(db, id, T0);
    failDigest(db, id, 'boom', T0);
    saveDigest(db, { sessionRowId: id, hash: 'h1', model: 'm1', body: BODY, text: 'old digest', now: T0 });
    markDigestPending(db, id, at(5000));
    expect(getDigest(db, id)).toMatchObject({ status: 'pending', text: 'old digest', attempts: 0, next_attempt_at: null });
  });

  it('follows the retry schedule: 1 minute, 5 minutes, 30 minutes, 2 hours, then daily', () => {
    expect(RETRY_DELAYS_MS).toEqual([60_000, 300_000, 1_800_000, 7_200_000]);
    const id = addSession('a');
    markDigestPending(db, id, T0);
    const waits: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = failDigest(db, id, `err ${i}`, T0);
      expect(r.attempts).toBe(i + 1);
      waits.push(Date.parse(r.next_attempt_at) - Date.parse(T0));
    }
    expect(waits).toEqual([60_000, 300_000, 1_800_000, 7_200_000, DAILY_RETRY_MS, DAILY_RETRY_MS]);
    expect(getDigest(db, id)).toMatchObject({ status: 'failed', error: 'err 5' });
  });

  it('a failed digest becomes due only when its wait is over', () => {
    const id = addSession('a');
    markDigestPending(db, id, T0);
    failDigest(db, id, 'boom', T0);
    expect(nextDueDigest(db, at(59_000))).toBeNull();
    expect(nextDueDigest(db, at(60_000))).toMatchObject({ session_id: id });
  });

  it('a refused digest is never due again until it is marked pending', () => {
    const id = addSession('a');
    markDigestPending(db, id, T0);
    refuseDigest(db, id, 'cyber', T0);
    expect(getDigest(db, id)).toMatchObject({ status: 'refused', error: 'cyber' });
    expect(nextDueDigest(db, at(10 * DAILY_RETRY_MS))).toBeNull();
    markDigestPending(db, id, T0);
    expect(nextDueDigest(db, T0)).not.toBeNull();
  });

  it('counts digests by status', () => {
    const [a, b, c] = [addSession('a'), addSession('b'), addSession('c')];
    for (const id of [a, b, c]) markDigestPending(db, id, T0);
    saveDigest(db, { sessionRowId: a, hash: 'h1', model: 'm', body: BODY, text: 't', now: T0 });
    failDigest(db, b, 'x', T0);
    expect(digestCounts(db)).toEqual({ pending: 1, ok: 1, failed: 1, refused: 0 });
  });

  it('removes the digest when its session is deleted', () => {
    const id = addSession('a');
    markDigestPending(db, id, T0);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    expect(getDigest(db, id)).toBeNull();
  });
});

describe('project state', () => {
  it('saves, reads and replaces a state page, tracking the last full rebuild', () => {
    addSession('a');
    const p = projectId();
    expect(getProjectState(db, p)).toBeNull();
    saveProjectState(db, p, { summary: 'S1', body: 'B1', model: 'm' }, T0, true);
    expect(getProjectState(db, p)).toEqual({ summary: 'S1', body: 'B1', model: 'm', updated_at: T0, rebuilt_at: T0, dirty: false, version: 1, digests_through: 0, written_by: null });
    saveProjectState(db, p, { summary: 'S2', body: 'B2', model: 'm' }, at(1000), false);
    expect(getProjectState(db, p)).toMatchObject({ summary: 'S2', updated_at: at(1000), rebuilt_at: T0 });
  });

  it('a save clears the dirty flag; delete removes the page', () => {
    addSession('a');
    const p = projectId();
    saveProjectState(db, p, { summary: 'S', body: 'B', model: 'm' }, T0, true);
    markStateDirty(db, p);
    expect(getProjectState(db, p)!.dirty).toBe(true);
    saveProjectState(db, p, { summary: 'S', body: 'B', model: 'm' }, T0, false);
    expect(getProjectState(db, p)!.dirty).toBe(false);
    deleteProjectState(db, p);
    expect(getProjectState(db, p)).toBeNull();
  });

  it('finds a project that has digests but no page, or a dirty page', () => {
    const id = addSession('a');
    const p = projectId();
    expect(nextProjectNeedingState(db)).toBeNull();
    markDigestPending(db, id, T0);
    expect(nextProjectNeedingState(db)).toBeNull(); // pending digests do not count
    saveDigest(db, { sessionRowId: id, hash: 'h1', model: 'm', body: BODY, text: 't', now: T0 });
    expect(nextProjectNeedingState(db)).toBe(p);
    saveProjectState(db, p, { summary: 'S', body: 'B', model: 'm' }, T0, true);
    expect(nextProjectNeedingState(db)).toBeNull();
    markStateDirty(db, p);
    expect(nextProjectNeedingState(db)).toBe(p);
  });

  it('finds a dirty page whose project has no digests left, so it can be removed', () => {
    addSession('a');
    const p = projectId();
    saveProjectState(db, p, { summary: 'S', body: 'B', model: 'm' }, T0, true);
    markStateDirty(db, p);
    expect(nextProjectNeedingState(db)).toBe(p);
  });

  it('lists the ok digests of a project, oldest first, main sessions only', () => {
    const a = addSession('a', { activity: '2026-10-03T00:00:00.000Z' });
    const b = addSession('b', { activity: '2026-10-01T00:00:00.000Z' });
    const pending = addSession('c');
    addSession('other', { project: 'local:beta' });
    for (const id of [a, b, pending]) markDigestPending(db, id, T0);
    saveDigest(db, { sessionRowId: a, hash: 'h1', model: 'm', body: BODY, text: 'digest a', now: T0 });
    saveDigest(db, { sessionRowId: b, hash: 'h1', model: 'm', body: BODY, text: 'digest b', now: T0 });
    expect(okDigestsForProject(db, projectId())).toEqual([
      { session_id: 'claude-code:b', title: 'title b', last_activity_at: '2026-10-01T00:00:00.000Z', text: 'digest b', saved_seq: 2 },
      { session_id: 'claude-code:a', title: 'title a', last_activity_at: '2026-10-03T00:00:00.000Z', text: 'digest a', saved_seq: 1 },
    ]);
  });

  it('removes the page when its project is deleted', () => {
    addSession('a');
    const p = projectId();
    saveProjectState(db, p, { summary: 'S', body: 'B', model: 'm' }, T0, true);
    db.prepare('DELETE FROM sessions').run();
    db.prepare('DELETE FROM projects WHERE id = ?').run(p);
    expect(getProjectState(db, p)).toBeNull();
  });
});

describe('subagent sessions', () => {
  it('a subagent row is neither due nor a reason to build a project page', () => {
    const parent = addSession('p');
    const sub = addSession('p/agent-1', { parent: 'p', project: 'local:beta' });
    markDigestPending(db, sub, T0);
    expect(nextDueDigest(db, T0)).toBeNull();
    markDigestPending(db, parent, T0);
    expect(nextDueDigest(db, T0)).toMatchObject({ session_id: parent });
    saveDigest(db, { sessionRowId: sub, hash: 'h1', model: 'm', body: BODY, text: 'sub', now: T0 });
    // beta has only an ok digest on a subagent session and no page: nothing to build.
    expect(nextProjectNeedingState(db)).toBeNull();
  });
});

describe('review fixes: restart and upgrade', () => {
  it('queued work survives closing and reopening the database file', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const path = join(mkdtempSync(join(tmpdir(), 'hub-restart-')), 'hub.sqlite');
    db = openDb(path);
    const pending = addSession('p');
    const failed = addSession('f');
    markDigestPending(db, pending, T0);
    markDigestPending(db, failed, T0);
    failDigest(db, failed, 'boom', T0);
    db.close();

    db = openDb(path);
    expect(nextDueDigest(db, T0)).toMatchObject({ session_id: pending });
    expect(getDigest(db, failed)).toMatchObject({ status: 'failed', attempts: 1 });
    expect(nextDueDigest(db, at(DAILY_RETRY_MS))).not.toBeNull();
    db.close();
  });

  it('upgrading a database that already holds sessions queues a digest for each main session', async () => {
    const Database = (await import('better-sqlite3')).default;
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const path = join(mkdtempSync(join(tmpdir(), 'hub-upgrade-')), 'hub.sqlite');
    db = openDb(path);
    const main = addSession('main');
    const sub = addSession('main/agent-1', { parent: 'main' });
    // Put the file back to how Part 2 left it: no digest tables, version 1.
    db.exec('DROP TABLE IF EXISTS state_retries; DROP TABLE project_states; DROP TABLE digests;');
    db.exec('DROP TABLE oauth_tokens; DROP TABLE oauth_codes; DROP TABLE oauth_grants; DROP TABLE connect_codes; DROP TABLE oauth_clients;');
    db.exec('DROP TABLE web_sessions; DROP TABLE sync_runs; DROP TABLE activity; DROP TABLE model_usage; DROP TABLE server_page_queue; DROP TABLE page_skips;');
    db.pragma('user_version = 1');
    db.close();

    const raw = new Database(path);
    expect(raw.pragma('user_version', { simple: true })).toBe(1);
    raw.close();

    db = openDb(path);
    expect(getDigest(db, main)).toMatchObject({ status: 'pending' });
    expect(getDigest(db, sub)).toBeNull();
    db.close();
  });
});

describe('computer-written summaries', () => {
  const okDigest = (id: string, text = 'T', over: { project?: string; writtenBy?: string | null } = {}) => {
    const sid = addSession(id, { project: over.project });
    markDigestPending(db, sid, T0);
    saveDigest(db, { sessionRowId: sid, hash: 'h1', model: 'm', body: BODY, text, now: T0, writtenBy: over.writtenBy ?? null });
    return sid;
  };
  const savedSeq = (sid: number) => (db.prepare('SELECT saved_seq FROM digests WHERE session_id = ?').get(sid) as { saved_seq: number }).saved_seq;

  it('saveDigest numbers saves in order', () => {
    const a = okDigest('a');
    const b = okDigest('b');
    expect([savedSeq(a), savedSeq(b)]).toEqual([1, 2]);
  });

  it('saveDigest records who wrote the digest', () => {
    const a = okDigest('a', 'T', { writtenBy: 'my-pc' });
    expect(getDigest(db, a)).toMatchObject({ status: 'ok' });
    expect((db.prepare('SELECT written_by FROM digests WHERE session_id = ?').get(a) as { written_by: string }).written_by).toBe('my-pc');
  });

  it('a new ok digest puts its project in projectsNeedingPage', () => {
    expect(projectsNeedingPage(db)).toEqual([]);
    okDigest('a');
    expect(projectsNeedingPage(db)).toEqual(['local:alpha']);
    savePageIfVersion(db, projectId(), { summary: 's', body: 'b', model: 'm' }, { baseVersion: null, through: 1, fullRebuild: true, writtenBy: null, now: T0 });
    expect(projectsNeedingPage(db)).toEqual([]);
    okDigest('b');
    expect(projectsNeedingPage(db)).toEqual(['local:alpha']);
  });

  it('savePageIfVersion refuses a stale base version', () => {
    okDigest('a');
    const first = savePageIfVersion(db, projectId(), { summary: 's', body: 'b', model: 'm' }, { baseVersion: null, through: 1, fullRebuild: true, writtenBy: 'pc', now: T0 });
    expect(first).toEqual({ ok: true, version: 1 });
    const stale = savePageIfVersion(db, projectId(), { summary: 's2', body: 'b2', model: 'm' }, { baseVersion: null, through: 1, fullRebuild: false, writtenBy: 'pc', now: T0 });
    expect(stale.ok).toBe(false);
    const next = savePageIfVersion(db, projectId(), { summary: 's2', body: 'b2', model: 'm' }, { baseVersion: 1, through: 1, fullRebuild: false, writtenBy: 'pc', now: T0 });
    expect(next).toEqual({ ok: true, version: 2 });
    const old = savePageIfVersion(db, projectId(), { summary: 's3', body: 'b3', model: 'm' }, { baseVersion: 1, through: 1, fullRebuild: false, writtenBy: 'pc', now: T0 });
    expect(old).toEqual({ ok: false, version: 2 });
    expect(getProjectState(db, projectId())).toMatchObject({ summary: 's2', version: 2, written_by: 'pc', digests_through: 1 });
  });

  it('a merge keeps the dirty flag and a full rebuild clears it', () => {
    okDigest('a');
    savePageIfVersion(db, projectId(), { summary: 's', body: 'b', model: 'm' }, { baseVersion: null, through: 1, fullRebuild: true, writtenBy: null, now: T0 });
    markStateDirty(db, projectId());
    const v = getProjectState(db, projectId())!.version;
    savePageIfVersion(db, projectId(), { summary: 's', body: 'b', model: 'm' }, { baseVersion: v, through: 1, fullRebuild: false, writtenBy: null, now: T0 });
    expect(getProjectState(db, projectId())!.dirty).toBe(true);
    savePageIfVersion(db, projectId(), { summary: 's', body: 'b', model: 'm' }, { baseVersion: v + 1, through: 1, fullRebuild: true, writtenBy: null, now: T0 });
    expect(getProjectState(db, projectId())!.dirty).toBe(false);
  });

  it('markStateDirty bumps the version', () => {
    okDigest('a');
    savePageIfVersion(db, projectId(), { summary: 's', body: 'b', model: 'm' }, { baseVersion: null, through: 1, fullRebuild: true, writtenBy: null, now: T0 });
    const v = getProjectState(db, projectId())!.version;
    markStateDirty(db, projectId());
    expect(getProjectState(db, projectId())!.version).toBe(v + 1);
  });

  it('markSummaryToFollow removes the digest text and its search entry', () => {
    const sid = okDigest('a', 'zebracrossing summary');
    savePageIfVersion(db, projectId(), { summary: 's', body: 'b', model: 'm' }, { baseVersion: null, through: 1, fullRebuild: true, writtenBy: null, now: T0 });
    const hits = () => db.prepare("SELECT 1 FROM search_index WHERE search_index MATCH 'zebracrossing' AND kind = 'digest'").all().length;
    expect(hits()).toBe(1);
    markSummaryToFollow(db, sid, T0);
    expect(hits()).toBe(0);
    expect(getDigest(db, sid)).toMatchObject({ status: 'pending', body: null, text: null });
    expect((db.prepare('SELECT summary_to_follow FROM digests WHERE session_id = ?').get(sid) as { summary_to_follow: number }).summary_to_follow).toBe(1);
    expect(getProjectState(db, projectId())!.dirty).toBe(true);
  });

  it('nextDueDigest skips summary_to_follow sessions', () => {
    const sid = okDigest('a');
    markSummaryToFollow(db, sid, T0);
    expect(nextDueDigest(db, T0)).toBeNull();
    const other = addSession('b');
    markDigestPending(db, other, T0);
    expect(nextDueDigest(db, T0)?.session_id).toBe(other);
  });
});
