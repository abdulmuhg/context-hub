import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db.js';

/** How long a browser stays signed in. Also the cookie's Max-Age, in seconds. */
export const SESSION_TTL_MS = 30 * 86_400_000;
export const COOKIE_NAME = 'hub_session';

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

export interface WebSessionRow {
  id: number;
  hash: string;
  csrf: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

/** Issues a browser session. The cookie value is returned once and kept only as a hash. */
export function createWebSession(db: Db, now: string): { cookie: string; csrf: string } {
  const cookie = randomBytes(32).toString('base64url');
  const csrf = randomBytes(32).toString('base64url');
  const expiresAt = new Date(new Date(now).getTime() + SESSION_TTL_MS).toISOString();
  db.prepare('INSERT INTO web_sessions(hash, csrf, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(
    sha256(cookie),
    csrf,
    now,
    now,
    expiresAt,
  );
  return { cookie, csrf };
}

/** Looks up a live session by its cookie value and marks it used. Null for missing, expired or revoked. */
export function checkWebSession(db: Db, cookieValue: string, now: string): { id: number; csrf: string } | null {
  if (cookieValue === '') return null;
  const row = db.prepare('SELECT id, csrf FROM web_sessions WHERE hash = ? AND revoked_at IS NULL AND expires_at > ?').get(sha256(cookieValue), now) as
    | { id: number; csrf: string }
    | undefined;
  if (!row) return null;
  db.prepare('UPDATE web_sessions SET last_used_at = ? WHERE id = ?').run(now, row.id);
  return row;
}

export function revokeWebSession(db: Db, id: number, now: string): boolean {
  return db.prepare('UPDATE web_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now, id).changes === 1;
}

export function listWebSessions(db: Db): WebSessionRow[] {
  const rows = db.prepare('SELECT * FROM web_sessions ORDER BY id').all() as {
    id: number;
    hash: string;
    csrf: string;
    created_at: string;
    last_used_at: string;
    expires_at: string;
    revoked_at: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    hash: r.hash,
    csrf: r.csrf,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
  }));
}

/**
 * What the Sign-ins page shows about a browser. The cookie hash and the anti-forgery value are
 * left out of the type, so neither can reach a page by accident.
 */
export interface BrowserRow {
  id: number;
  createdAt: string;
  lastUsedAt: string;
  revokedAt: string | null;
}

/** The browsers for the Sign-ins page, oldest first. Revoked ones stay listed. */
export function listBrowsers(db: Db): BrowserRow[] {
  const rows = db.prepare('SELECT id, created_at, last_used_at, revoked_at FROM web_sessions ORDER BY id').all() as {
    id: number;
    created_at: string;
    last_used_at: string;
    revoked_at: string | null;
  }[];
  return rows.map((r) => ({ id: r.id, createdAt: r.created_at, lastUsedAt: r.last_used_at, revokedAt: r.revoked_at }));
}

/** Compares a submitted anti-forgery token with the stored one without leaking where they differ. */
export function sameCsrf(submitted: string, stored: string): boolean {
  const a = Buffer.from(submitted, 'utf8');
  const b = Buffer.from(stored, 'utf8');
  // timingSafeEqual throws on different lengths, and the length of a csrf value is not a secret.
  return a.length === b.length && timingSafeEqual(a, b);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (name === '' || name in out) continue;
    out[name] = part.slice(eq + 1).trim();
  }
  return out;
}

const attributes = (secure: boolean): string => `Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;

export function sessionCookie(value: string, secure: boolean): string {
  return `${COOKIE_NAME}=${value}; Max-Age=${SESSION_TTL_MS / 1000}; ${attributes(secure)}`;
}

export function clearedCookie(secure: boolean): string {
  return `${COOKIE_NAME}=; Max-Age=0; ${attributes(secure)}`;
}
