import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import {
  forgetActivityForProject,
  forgetActivityForSession,
  latestSyncRun,
  listActivity,
  logActivity,
  recordSyncRun,
} from '../src/activity.js';

const entry = (over: Partial<Parameters<typeof logActivity>[1]> = {}) => ({
  direction: 'out' as const,
  action: 'search' as const,
  projectKey: null,
  sessionRef: null,
  actor: 'Claude',
  detail: null,
  ...over,
});

describe('activity log', () => {
  it('lists newest first with a direction filter and paging', () => {
    const db = openDb(':memory:');
    logActivity(db, entry({ direction: 'in', action: 'upload', detail: 'a' }), '2026-10-20T01:00:00.000Z');
    logActivity(db, entry({ detail: 'b' }), '2026-10-20T02:00:00.000Z');
    logActivity(db, entry({ direction: 'in', action: 'note', detail: 'c' }), '2026-10-20T03:00:00.000Z');
    expect(listActivity(db, { limit: 10, offset: 0 }).map((r) => r.detail)).toEqual(['c', 'b', 'a']);
    expect(listActivity(db, { direction: 'in', limit: 10, offset: 0 }).map((r) => r.detail)).toEqual(['c', 'a']);
    expect(listActivity(db, { limit: 1, offset: 1 }).map((r) => r.detail)).toEqual(['b']);
    const row = listActivity(db, { direction: 'out', limit: 1, offset: 0 })[0]!;
    expect(row).toEqual({
      id: expect.any(Number),
      at: '2026-10-20T02:00:00.000Z',
      direction: 'out',
      action: 'search',
      projectKey: null,
      sessionRef: null,
      actor: 'Claude',
      detail: 'b',
    });
  });

  it('prunes rows older than 30 days on the next write', () => {
    const db = openDb(':memory:');
    logActivity(db, entry({ detail: 'old' }), '2026-09-01T00:00:00.000Z');
    logActivity(db, entry({ detail: 'recent' }), '2026-09-25T00:00:00.000Z');
    logActivity(db, entry({ detail: 'new' }), '2026-10-20T00:00:00.000Z');
    expect(listActivity(db, { limit: 10, offset: 0 }).map((r) => r.detail)).toEqual(['new', 'recent']);
    logActivity(db, entry({ detail: 'newer' }), '2026-10-30T00:00:00.000Z');
    expect(listActivity(db, { limit: 10, offset: 0 }).map((r) => r.detail)).toEqual(['newer', 'new']);
  });

  it('forgets only the named session', () => {
    const db = openDb(':memory:');
    logActivity(db, entry({ sessionRef: 's1', detail: 'one' }), '2026-10-20T01:00:00.000Z');
    logActivity(db, entry({ sessionRef: 's2', detail: 'two' }), '2026-10-20T02:00:00.000Z');
    forgetActivityForSession(db, 's1');
    expect(listActivity(db, { limit: 10, offset: 0 }).map((r) => r.detail)).toEqual(['two']);
  });

  it('forgets every row of a project', () => {
    const db = openDb(':memory:');
    logActivity(db, entry({ projectKey: 'local:a', sessionRef: 's1', detail: 'a1' }), '2026-10-20T01:00:00.000Z');
    logActivity(db, entry({ projectKey: 'local:a', detail: 'a2' }), '2026-10-20T02:00:00.000Z');
    logActivity(db, entry({ projectKey: 'local:b', detail: 'b1' }), '2026-10-20T03:00:00.000Z');
    forgetActivityForProject(db, 'local:a');
    expect(listActivity(db, { limit: 10, offset: 0 }).map((r) => r.detail)).toEqual(['b1']);
  });
});

describe('sync runs', () => {
  it('stores a run, logs one sync row, and returns the newest run', () => {
    const db = openDb(':memory:');
    expect(latestSyncRun(db)).toBeNull();
    recordSyncRun(db, { tokenId: 1, finishedAt: '2026-10-20T01:00:00.000Z', uploaded: 3, unchanged: 7, errors: 0 }, '2026-10-20T01:00:05.000Z');
    recordSyncRun(db, { tokenId: 2, finishedAt: '2026-10-20T02:00:00.000Z', uploaded: 1, unchanged: 2, errors: 4 }, '2026-10-20T02:00:05.000Z');
    expect(latestSyncRun(db)).toEqual({
      id: expect.any(Number),
      tokenId: 2,
      finishedAt: '2026-10-20T02:00:00.000Z',
      uploaded: 1,
      unchanged: 2,
      errors: 4,
      receivedAt: '2026-10-20T02:00:05.000Z',
    });
    const rows = listActivity(db, { direction: 'in', limit: 10, offset: 0 });
    expect(rows.map((r) => [r.action, r.detail])).toEqual([
      ['sync', '1 uploaded, 2 unchanged, 4 errors'],
      ['sync', '3 uploaded, 7 unchanged'],
    ]);
  });
});
