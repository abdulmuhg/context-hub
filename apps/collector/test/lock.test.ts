import { existsSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { releaseLock, startLockHeartbeat, takeLock } from '../src/lock.js';
import { tempDir, writeRaw } from './helpers.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) };
});

const T0 = new Date('2026-10-21T10:00:00.000Z');
const MIN = 60 * 1000;
const lockPath = () => join(tempDir(), 'auto.lock');
const content = (p: string) => JSON.parse(readFileSync(p, 'utf8')) as { token: string; at: string };

describe('the sync lock', () => {
  it('a heartbeat keeps the lock fresh past 10 minutes', async () => {
    const path = lockPath();
    let clock = T0;
    const held = takeLock(path, clock);
    expect(held).not.toBeNull();
    const stop = startLockHeartbeat(held!, () => clock, 5);
    clock = new Date(T0.getTime() + 11 * MIN);
    await new Promise((r) => setTimeout(r, 50));
    expect(takeLock(path, clock)).toBeNull();
    stop();
  });

  it('without a heartbeat the lock is taken over after 10 minutes', () => {
    const path = lockPath();
    expect(takeLock(path, T0)).not.toBeNull();
    expect(takeLock(path, new Date(T0.getTime() + 11 * MIN))).not.toBeNull();
  });

  it('a fresh lock is not taken', () => {
    const path = lockPath();
    expect(takeLock(path, T0)).not.toBeNull();
    expect(takeLock(path, new Date(T0.getTime() + MIN))).toBeNull();
  });

  it('the heartbeat never brings back a lock that was removed', async () => {
    const path = lockPath();
    const held = takeLock(path, T0)!;
    const stop = startLockHeartbeat(held, () => T0, 5);
    unlinkSync(path);
    await new Promise((r) => setTimeout(r, 40));
    stop();
    expect(existsSync(path)).toBe(false);
  });

  it('release removes a lock it still owns', () => {
    const path = lockPath();
    releaseLock(takeLock(path, T0)!);
    expect(existsSync(path)).toBe(false);
  });

  it('release keeps a lock owned by another token', () => {
    const path = lockPath();
    const a = takeLock(path, T0)!;
    const b = takeLock(path, new Date(T0.getTime() + 11 * MIN))!;
    releaseLock(a);
    expect(content(path).token).toBe(b.token);
  });

  it('heartbeat leaves a foreign lock alone', async () => {
    const path = lockPath();
    const a = takeLock(path, T0)!;
    const takeoverAt = new Date(T0.getTime() + 11 * MIN);
    takeLock(path, takeoverAt);
    const stop = startLockHeartbeat(a, () => new Date(T0.getTime() + 20 * MIN), 5);
    await new Promise((r) => setTimeout(r, 40));
    stop();
    expect(content(path).at).toBe(takeoverAt.toISOString());
  });

  it('reads an old plain-date lock', () => {
    const path = lockPath();
    writeRaw(path, T0.toISOString());
    expect(takeLock(path, new Date(T0.getTime() + MIN))).toBeNull();
    expect(takeLock(path, new Date(T0.getTime() + 11 * MIN))).not.toBeNull();
  });

  it('treats an unreadable lock as held while its file is fresh', () => {
    const path = lockPath();
    writeRaw(path, 'garbage');
    expect(takeLock(path, new Date())).toBeNull();
  });

  it('takes over an unreadable lock once its file is older than 10 minutes', () => {
    const path = lockPath();
    writeRaw(path, 'garbage');
    const old = new Date(Date.now() - 11 * MIN);
    utimesSync(path, old, old);
    expect(takeLock(path, new Date())).not.toBeNull();
  });

  it('treats a busy lock file (EPERM) as held', () => {
    const path = lockPath();
    expect(takeLock(path, T0)).not.toBeNull();
    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    });
    expect(takeLock(path, new Date(T0.getTime() + MIN))).toBeNull();
  });

  it('throws, rather than reporting the lock held, when the folder is missing', () => {
    expect(() => takeLock(join(tempDir(), 'no-such-folder', 'auto.lock'), T0)).toThrow();
  });
});
