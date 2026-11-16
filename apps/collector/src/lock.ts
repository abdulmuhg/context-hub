import { randomUUID } from 'node:crypto';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';

export const LOCK_FILE = 'auto.lock';
export const RERUN_FILE = 'auto.rerun';
export const LOCK_MAX_AGE_MS = 10 * 60 * 1000;

export interface Held {
  path: string;
  token: string;
}

interface LockContent {
  token: string | null;
  at: number;
}

/** The lock's owner and time. Reads JSON `{token, at}`, or the old plain ISO date. Null when neither parses. */
function readLock(path: string): LockContent | null {
  const raw = readFileSync(path, 'utf8').trim();
  try {
    const j = JSON.parse(raw) as { token?: unknown; at?: unknown };
    if (j && typeof j === 'object') {
      const at = typeof j.at === 'string' ? Date.parse(j.at) : NaN;
      if (Number.isFinite(at)) return { token: typeof j.token === 'string' ? j.token : null, at };
    }
  } catch {
    // not JSON: try the old plain date
  }
  const at = Date.parse(raw);
  return Number.isFinite(at) ? { token: null, at } : null;
}

function body(token: string, at: Date): string {
  return JSON.stringify({ token, at: at.toISOString() });
}

/** Creates or takes over a stale lock. Null when a fresh one exists. */
export function takeLock(lockPath: string, now: Date, token: string = `${process.pid}-${randomUUID()}`): Held | null {
  try {
    writeFileSync(lockPath, body(token, now), { flag: 'wx' });
    return { path: lockPath, token };
  } catch {
    // held, or left behind
  }
  try {
    const cur = readLock(lockPath);
    if (cur && now.getTime() - cur.at < LOCK_MAX_AGE_MS) return null;
    writeFileSync(lockPath, body(token, now));
    return { path: lockPath, token };
  } catch {
    return null;
  }
}

function owns(held: Held): boolean {
  try {
    return readLock(held.path)?.token === held.token;
  } catch {
    return false;
  }
}

/**
 * Keeps the lock fresh while a sync works. Writing summaries can take longer than the lock's 10 minutes, and
 * another sync must not start meanwhile and write the same ones. It only touches a lock that still carries
 * held.token. Returns the function that stops it.
 */
export function startLockHeartbeat(held: Held, now: () => Date, everyMs = 60_000): () => void {
  const timer = setInterval(() => {
    try {
      if (owns(held)) writeFileSync(held.path, body(held.token, now()));
    } catch {
      // the lock is only a courtesy to the next run
    }
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

/** Unlinks the lock only while it still carries held.token. */
export function releaseLock(held: Held): void {
  try {
    if (owns(held)) unlinkSync(held.path);
  } catch {
    // best effort
  }
}
