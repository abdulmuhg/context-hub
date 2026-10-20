import { createHash, randomBytes } from 'node:crypto';
import type { Db } from './db.js';
import type { HubScope } from './oauth/config.js';
import { findToken } from './oauth/store.js';

export type Scope = 'ingest' | 'read';

export interface TokenRow {
  id: number;
  label: string;
  scope: Scope;
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createToken(db: Db, label: string, scope: Scope, now: string): { id: number; token: string } {
  const token = 'chub_' + randomBytes(32).toString('base64url');
  const info = db
    .prepare('INSERT INTO tokens(label, scope, hash, created_at) VALUES (?, ?, ?, ?)')
    .run(label, scope, hashToken(token), now);
  return { id: Number(info.lastInsertRowid), token };
}

export function verifyToken(db: Db, token: string, now: string): { id: number; scope: Scope } | null {
  if (token === '') return null;
  const row = db
    .prepare('SELECT id, scope FROM tokens WHERE hash = ? AND revoked_at IS NULL')
    .get(hashToken(token)) as { id: number; scope: Scope } | undefined;
  if (!row) return null;
  db.prepare('UPDATE tokens SET last_used_at = ? WHERE id = ?').run(now, row.id);
  return row;
}

export function listTokens(db: Db): TokenRow[] {
  return db
    .prepare('SELECT id, label, scope, created_at, revoked_at, last_used_at FROM tokens ORDER BY id')
    .all() as TokenRow[];
}

export function revokeToken(db: Db, id: number, now: string): boolean {
  const info = db.prepare('UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now, id);
  return info.changes === 1;
}

export type Credential =
  | { kind: 'bearer'; scope: Scope }
  | { kind: 'oauth'; grantId: number; scopes: HubScope[] };

/**
 * Classifies a presented bearer token. 'dead' means this hub issued it but it is expired or revoked,
 * which is a stale credential rather than a guess; null means the hub has never heard of it.
 */
export function checkCredential(db: Db, token: string, now: string): Credential | 'dead' | null {
  if (token === '') return null;
  if (token.startsWith('chub_at_')) {
    const t = findToken(db, token);
    if (!t || t.kind !== 'access') return null;
    if (t.expiresAt <= now || t.grant.revokedAt !== null) return 'dead';
    return { kind: 'oauth', grantId: t.grantId, scopes: t.grant.scopes };
  }
  if (token.startsWith('chub_rt_')) return null;
  const row = db.prepare('SELECT id, scope, revoked_at FROM tokens WHERE hash = ?').get(hashToken(token)) as
    | { id: number; scope: Scope; revoked_at: string | null }
    | undefined;
  if (!row) return null;
  if (row.revoked_at !== null) return 'dead';
  db.prepare('UPDATE tokens SET last_used_at = ? WHERE id = ?').run(now, row.id);
  return { kind: 'bearer', scope: row.scope };
}
