import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db.js';
import { getDigest, getProjectState, markStateDirty, nextDueDigest, saveDigest, saveProjectState, type DigestBody } from '../src/digest-store.js';
import { deleteProject, deleteSession, getProject, getSessionPage, listProjects, resolveProject, status, upsertSession } from '../src/store.js';
import { makeSession, text } from './helpers.js';

const NOW = '2026-10-11T00:00:00.000Z';
const LATER = '2026-10-12T00:00:00.000Z';
const BODY: DigestBody = { goal: 'g', done: [], decisions: [], open_items: [], key_refs: [] };
let db: Db;

const rowId = (id: string) => (db.prepare('SELECT id FROM sessions WHERE source_session_id = ?').get(id) as { id: number }).id;
const projectId = (key: string) => {
  const r = resolveProject(db, key);
  if (!r.ok) throw new Error(`no project ${key}`);
  return r.id;
};
const digestIt = (id: string, body = 'digest of ' + id) => {
  const s = db.prepare('SELECT id, content_hash FROM sessions WHERE source_session_id = ?').get(id) as { id: number; content_hash: string };
  saveDigest(db, { sessionRowId: s.id, hash: s.content_hash, model: 'm1', body: BODY, text: body, now: NOW });
};

beforeEach(() => {
  db = openDb(':memory:');
});

describe('queueing', () => {
  it('queues a digest for a new main session', () => {
    upsertSession(db, makeSession({ source_session_id: 'a' }), NOW);
    expect(nextDueDigest(db, NOW)).toMatchObject({ source_session_id: 'a' });
  });

  it('does not queue a subagent transcript', () => {
    upsertSession(db, makeSession({ source_session_id: 'a/agent-1', parent: 'a' }), NOW);
    expect(nextDueDigest(db, NOW)).toBeNull();
    expect(getDigest(db, rowId('a/agent-1'))).toBeNull();
  });

  it('does not queue a document, new or changed', () => {
    const doc = (body: string) =>
      makeSession({ source: 'doc', source_session_id: 'github.com/me/alpha#knowledge/INDEX.md', messages: [text(0, 'user', body)] });
    upsertSession(db, doc('first'), NOW);
    upsertSession(db, doc('second'), LATER);
    expect(nextDueDigest(db, LATER)).toBeNull();
    expect(getDigest(db, rowId('github.com/me/alpha#knowledge/INDEX.md'))).toBeNull();
    expect(getSessionPage(db, 'doc', 'github.com/me/alpha#knowledge/INDEX.md', 0)?.messages[0]).toMatchObject({ text: 'second' });
  });

  it('queues again when the session changes, but not when the same content is sent twice', () => {
    upsertSession(db, makeSession({ source_session_id: 'a' }), NOW);
    digestIt('a');
    upsertSession(db, makeSession({ source_session_id: 'a' }), LATER);
    expect(getDigest(db, rowId('a'))!.status).toBe('ok');
    upsertSession(db, makeSession({ source_session_id: 'a', messages: [text(0, 'user', 'changed')] }), LATER);
    expect(getDigest(db, rowId('a'))).toMatchObject({ status: 'pending', text: 'digest of a' });
  });

  it('removes the old digest from search when the session changes', () => {
    upsertSession(db, makeSession({ source_session_id: 'a' }), NOW);
    digestIt('a');
    upsertSession(db, makeSession({ source_session_id: 'a', messages: [text(0, 'user', 'changed')] }), LATER);
    expect(db.prepare("SELECT COUNT(*) AS n FROM search_index WHERE kind = 'digest'").get()).toEqual({ n: 0 });
  });
});

// Review Focus 4
describe('state pages follow sessions', () => {
  beforeEach(() => {
    upsertSession(db, makeSession({ source_session_id: 'a' }), NOW);
    upsertSession(db, makeSession({ source_session_id: 'b' }), NOW);
    saveProjectState(db, projectId('alpha'), { summary: 'S', body: 'B', model: 'm' }, NOW, true);
  });

  it('marks the old project dirty when a session moves to another project', () => {
    upsertSession(db, makeSession({ source_session_id: 'a', project_key: 'local:other' }), LATER);
    expect(getProjectState(db, projectId('alpha'))!.dirty).toBe(true);
  });

  it('marks the project dirty when one of its sessions is deleted', () => {
    deleteSession(db, 'claude-code', 'a');
    expect(getProjectState(db, projectId('alpha'))!.dirty).toBe(true);
  });

  it('leaves the page alone when a document is deleted or moves away', () => {
    const doc = (key: string, id: string) =>
      makeSession({ source: 'doc', source_session_id: `github.com/me/alpha#kb/${id}.md`, project_key: key });
    upsertSession(db, doc('github.com/me/alpha', 'one'), NOW);
    upsertSession(db, doc('github.com/me/alpha', 'two'), NOW);
    deleteSession(db, 'doc', 'github.com/me/alpha#kb/one.md');
    upsertSession(db, doc('local:other', 'two'), LATER);
    expect(getProjectState(db, projectId('alpha'))!.dirty).toBe(false);
  });

  it('removes the page with the project when its last session is deleted', () => {
    const p = projectId('alpha');
    deleteProject(db, 'github.com/me/alpha');
    expect(getProjectState(db, p)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM digests').get()).toEqual({ n: 0 });
  });

  it('does not mark anything dirty for an unchanged upload', () => {
    upsertSession(db, makeSession({ source_session_id: 'a' }), LATER);
    expect(getProjectState(db, projectId('alpha'))!.dirty).toBe(false);
  });
});

describe('lookups return digests and state', () => {
  beforeEach(() => {
    upsertSession(db, makeSession({ source_session_id: 'a' }), NOW);
  });

  // Review Focus 5
  it('reports a session waiting for its digest', () => {
    const view = getProject(db, projectId('alpha'), 5);
    expect(view.state).toBeNull();
    expect(view.recent[0]).toMatchObject({ digest: null, digest_status: 'pending' });
  });

  it('returns the digest once written', () => {
    digestIt('a', 'Goal: fix login');
    expect(getProject(db, projectId('alpha'), 5).recent[0]).toMatchObject({
      digest: { text: 'Goal: fix login', model: 'm1', written_at: NOW, stale: false },
      digest_status: 'ok',
    });
    expect(getSessionPage(db, 'claude-code', 'a', 0)!.session.digest).toMatchObject({ text: 'Goal: fix login', stale: false });
  });

  it('marks the digest stale while a changed session waits for a new one', () => {
    digestIt('a', 'old');
    upsertSession(db, makeSession({ source_session_id: 'a', messages: [text(0, 'user', 'changed')] }), LATER);
    expect(getProject(db, projectId('alpha'), 5).recent[0]).toMatchObject({ digest: { text: 'old', stale: true }, digest_status: 'pending' });
  });

  it('reports none for a subagent transcript', () => {
    upsertSession(db, makeSession({ source_session_id: 'a/agent-1', parent: 'a' }), NOW);
    expect(getSessionPage(db, 'claude-code', 'a/agent-1', 0)!.session).toMatchObject({ digest: null, digest_status: 'none' });
  });

  it('returns the state page, flags it stale when dirty, and shows its summary in the project list', () => {
    const p = projectId('alpha');
    saveProjectState(db, p, { summary: 'Login flow is fixed.', body: '## Current state\nDone.', model: 'm' }, NOW, true);
    expect(getProject(db, p, 5).state).toEqual({ summary: 'Login flow is fixed.', body: '## Current state\nDone.', updated_at: NOW, stale: false });
    expect(listProjects(db)[0]!.summary).toBe('Login flow is fixed.');
    markStateDirty(db, p);
    expect(getProject(db, p, 5).state!.stale).toBe(true);
  });

  it('counts digests in status', () => {
    upsertSession(db, makeSession({ source_session_id: 'b' }), NOW);
    digestIt('a');
    expect(status(db).digests).toEqual({ pending: 1, ok: 1, failed: 0, refused: 0 });
  });
});
