import type { Db } from './db.js';

/** The most addresses the waitlist holds; the form is public, so it must not grow without bound. */
export const WAITLIST_MAX = 10_000;

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Trimmed, lowercased address, or null when it is not one (or is longer than 254 characters). */
export function normalizeEmail(raw: string | null): string | null {
  if (raw === null) return null;
  const email = raw.trim().toLowerCase();
  if (email.length === 0 || email.length > 254 || !EMAIL_SHAPE.test(email)) return null;
  return email;
}

/** Takes an already-normalised address. A listed address never sees 'full'. */
export function addToWaitlist(db: Db, email: string, now: string): 'added' | 'exists' | 'full' {
  if (db.prepare('SELECT 1 FROM waitlist WHERE email = ?').get(email)) return 'exists';
  if (countWaitlist(db) >= WAITLIST_MAX) return 'full';
  db.prepare('INSERT INTO waitlist(email, created_at) VALUES (?, ?)').run(email, now);
  return 'added';
}

export function countWaitlist(db: Db): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM waitlist').get() as { n: number }).n;
}

/** Oldest first. */
export function listWaitlist(db: Db): Array<{ email: string; created_at: string }> {
  return db.prepare('SELECT email, created_at FROM waitlist ORDER BY created_at, rowid').all() as Array<{ email: string; created_at: string }>;
}

export function removeFromWaitlist(db: Db, email: string): boolean {
  return db.prepare('DELETE FROM waitlist WHERE email = ?').run(email).changes === 1;
}

/** The newest addresses first, at most `limit` of them: what the dashboard shows. */
export function recentWaitlist(db: Db, limit: number): Array<{ email: string; created_at: string }> {
  return db.prepare('SELECT email, created_at FROM waitlist ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit) as Array<{ email: string; created_at: string }>;
}
