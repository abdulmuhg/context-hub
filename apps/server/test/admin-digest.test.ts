import { beforeEach, describe, expect, it } from 'vitest';
import { runAdmin, type AdminIo } from '../src/admin.js';
import { openDb } from '../src/db.js';
import { failDigest, getDigest, getProjectState, refuseDigest } from '../src/digest-store.js';
import { upsertSession } from '../src/store.js';
import { runOnce } from '../src/worker.js';
import { FakeLlm, makeSession } from './helpers.js';

const NOW = new Date('2026-10-11T00:00:00.000Z');
let io: AdminIo;
let out: string[];
let err: string[];
const rowId = (id: string) => (io.db.prepare('SELECT id FROM sessions WHERE source_session_id = ?').get(id) as { id: number }).id;
const drain = async () => {
  const llm = new FakeLlm();
  for (let i = 0; i < 20; i++) if ((await runOnce({ db: io.db, llm, now: () => NOW, log: () => {} })) === 'idle') return;
};

beforeEach(async () => {
  out = [];
  err = [];
  io = { db: openDb(':memory:'), out: (l) => out.push(l), err: (l) => err.push(l), now: () => NOW };
  upsertSession(io.db, makeSession({ source_session_id: 'a' }), NOW.toISOString());
  upsertSession(io.db, makeSession({ source_session_id: 'b' }), NOW.toISOString());
  upsertSession(io.db, makeSession({ source_session_id: 'b/agent-1', parent: 'b' }), NOW.toISOString());
  upsertSession(io.db, makeSession({ source_session_id: 'c', project_key: 'local:beta' }), NOW.toISOString());
  await drain();
});

describe('hub-admin redigest', () => {
  it('queues every main session of a project, found by short name', async () => {
    expect(await runAdmin(['redigest', 'alpha'], io)).toBe(0);
    expect(out.join('\n')).toMatch(/2 session/);
    expect(getDigest(io.db, rowId('a'))!.status).toBe('pending');
    expect(getDigest(io.db, rowId('b'))!.status).toBe('pending');
    expect(getDigest(io.db, rowId('c'))!.status).toBe('ok');
  });

  it('queues one session with --session', async () => {
    expect(await runAdmin(['redigest', '--session', 'claude-code:a'], io)).toBe(0);
    expect(getDigest(io.db, rowId('a'))!.status).toBe('pending');
    expect(getDigest(io.db, rowId('b'))!.status).toBe('ok');
  });

  it('queues only failed digests with --failed, across projects or in one', async () => {
    failDigest(io.db, rowId('a'), 'credit balance is too low', NOW.toISOString());
    failDigest(io.db, rowId('c'), 'credit balance is too low', NOW.toISOString());
    refuseDigest(io.db, rowId('b'), 'cyber', NOW.toISOString());
    expect(await runAdmin(['redigest', '--failed', 'alpha'], io)).toBe(0);
    expect(out.at(-1)).toBe('Queued 1 failed session of github.com/me/alpha.');
    expect(getDigest(io.db, rowId('a'))).toMatchObject({ status: 'pending', attempts: 0, error: null });
    expect(getDigest(io.db, rowId('c'))!.status).toBe('failed');
    expect(await runAdmin(['redigest', '--failed'], io)).toBe(0);
    expect(out.at(-1)).toBe('Queued 1 failed session.');
    expect(getDigest(io.db, rowId('c'))!.status).toBe('pending');
    expect(getDigest(io.db, rowId('b'))!.status).toBe('refused');
  });

  it('gives a refused session another chance', async () => {
    refuseDigest(io.db, rowId('a'), 'cyber', NOW.toISOString());
    await runAdmin(['redigest', '--session', 'claude-code:a'], io);
    expect(getDigest(io.db, rowId('a'))).toMatchObject({ status: 'pending', error: null });
  });

  it('refuses an unknown project, an unknown session and a subagent transcript', async () => {
    expect(await runAdmin(['redigest', 'gamma'], io)).toBe(1);
    expect(err.join('\n')).toMatch(/github\.com\/me\/alpha/);
    expect(await runAdmin(['redigest', '--session', 'claude-code:nope'], io)).toBe(1);
    expect(await runAdmin(['redigest', '--session', 'claude-code:b/agent-1'], io)).toBe(1);
    expect(err.join('\n')).toMatch(/subagent/);
    expect(await runAdmin(['redigest'], io)).toBe(1);
  });
});

describe('hub-admin rebuild-state', () => {
  it('marks the page for a full rebuild', async () => {
    const id = (io.db.prepare("SELECT id FROM projects WHERE key = 'github.com/me/alpha'").get() as { id: number }).id;
    expect(getProjectState(io.db, id)!.dirty).toBe(false);
    expect(await runAdmin(['rebuild-state', 'alpha'], io)).toBe(0);
    expect(getProjectState(io.db, id)!.dirty).toBe(true);
  });

  it('says so when the project has no page yet', async () => {
    upsertSession(io.db, makeSession({ source_session_id: 'n', project_key: 'local:new' }), NOW.toISOString());
    expect(await runAdmin(['rebuild-state', 'new'], io)).toBe(0);
    expect(out.join('\n')).toMatch(/no state page yet/i);
  });
});

describe('hub-admin digests', () => {
  it('prints counts and lists failed and refused sessions with the reason', async () => {
    failDigest(io.db, rowId('a'), '529 overloaded', NOW.toISOString());
    refuseDigest(io.db, rowId('c'), 'cyber', NOW.toISOString());
    expect(await runAdmin(['digests'], io)).toBe(0);
    const text = out.join('\n');
    expect(text).toMatch(/ok: 1/);
    expect(text).toMatch(/failed: 1/);
    expect(text).toMatch(/refused: 1/);
    expect(text).toMatch(/claude-code:a.*529 overloaded/);
    expect(text).toMatch(/claude-code:c.*cyber/);
  });
});
