import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { Db } from '../db.js';
import { SCOPES, TTL, type HubScope } from './config.js';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const rand = (prefix: string): string => prefix + randomBytes(32).toString('base64url');
const plus = (iso: string, ms: number): string => new Date(new Date(iso).getTime() + ms).toISOString();
const normalizeCode = (input: string): string => input.toUpperCase().replace(/[\s-]/g, '');

// ---- connect codes ----

export function createConnectCode(db: Db, now: string): { code: string; expiresAt: string } {
  let raw = '';
  for (let i = 0; i < 8; i++) raw += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  const expiresAt = plus(now, TTL.connectCode);
  db.prepare('INSERT INTO connect_codes(hash, created_at, expires_at) VALUES (?, ?, ?)').run(sha256(raw), now, expiresAt);
  return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expiresAt };
}

export function consumeConnectCode(db: Db, input: string, now: string): boolean {
  const info = db
    .prepare('UPDATE connect_codes SET used_at = ? WHERE hash = ? AND used_at IS NULL AND expires_at > ?')
    .run(now, sha256(normalizeCode(input)), now);
  return info.changes === 1;
}

// ---- clients ----

export interface StoredClient {
  clientId: string;
  kind: 'dcr' | 'cimd';
  name: string;
  redirectUris: string[];
  createdAt: string;
  fetchedAt: string;
}

export function saveClient(
  db: Db,
  c: { clientId: string; kind: 'dcr' | 'cimd'; name: string; redirectUris: string[] },
  now: string,
): void {
  db.prepare(
    `INSERT INTO oauth_clients(client_id, kind, name, redirect_uris, created_at, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(client_id) DO UPDATE SET kind = excluded.kind, name = excluded.name,
       redirect_uris = excluded.redirect_uris, fetched_at = excluded.fetched_at`,
  ).run(c.clientId, c.kind, c.name, JSON.stringify(c.redirectUris), now, now);
}

export function getClient(db: Db, clientId: string): StoredClient | null {
  const r = db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(clientId) as
    | { client_id: string; kind: 'dcr' | 'cimd'; name: string; redirect_uris: string; created_at: string; fetched_at: string }
    | undefined;
  if (!r) return null;
  return {
    clientId: r.client_id,
    kind: r.kind,
    name: r.name,
    redirectUris: JSON.parse(r.redirect_uris) as string[],
    createdAt: r.created_at,
    fetchedAt: r.fetched_at,
  };
}

/** Deletes DCR clients registered over 30 days ago that never got a grant. */
export function pruneClients(db: Db, now: string): number {
  const cutoff = plus(now, -30 * 86_400_000);
  return db
    .prepare(
      `DELETE FROM oauth_clients WHERE kind = 'dcr' AND created_at < ?
       AND client_id NOT IN (SELECT client_id FROM oauth_grants)`,
    )
    .run(cutoff).changes;
}

// ---- grants ----

export interface GrantRow {
  id: number;
  clientId: string;
  clientName: string;
  scopes: HubScope[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

const parseScopes = (s: string): HubScope[] =>
  s.split(' ').filter((x): x is HubScope => (SCOPES as readonly string[]).includes(x));

export function createGrant(db: Db, g: { clientId: string; clientName: string; scopes: HubScope[] }, now: string): number {
  const info = db
    .prepare('INSERT INTO oauth_grants(client_id, client_name, scopes, created_at) VALUES (?, ?, ?, ?)')
    .run(g.clientId, g.clientName, g.scopes.join(' '), now);
  return Number(info.lastInsertRowid);
}

export function listGrants(db: Db): GrantRow[] {
  const rows = db.prepare('SELECT * FROM oauth_grants ORDER BY id').all() as {
    id: number;
    client_id: string;
    client_name: string;
    scopes: string;
    created_at: string;
    last_used_at: string | null;
    revoked_at: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    clientId: r.client_id,
    clientName: r.client_name,
    scopes: parseScopes(r.scopes),
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    revokedAt: r.revoked_at,
  }));
}

export function revokeGrant(db: Db, id: number, now: string): boolean {
  return db.prepare('UPDATE oauth_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now, id).changes === 1;
}

export function touchGrant(db: Db, grantId: number, now: string): void {
  db.prepare('UPDATE oauth_grants SET last_used_at = ? WHERE id = ?').run(now, grantId);
}

// ---- authorization codes ----

export interface AuthCodeRow {
  hash: string;
  grantId: number;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  expiresAt: string;
  usedAt: string | null;
}

export function createAuthCode(
  db: Db,
  c: { grantId: number; clientId: string; redirectUri: string; codeChallenge: string; resource: string },
  now: string,
): string {
  const code = rand('chub_ac_');
  db.prepare(
    `INSERT INTO oauth_codes(hash, grant_id, client_id, redirect_uri, code_challenge, resource, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(sha256(code), c.grantId, c.clientId, c.redirectUri, c.codeChallenge, c.resource, plus(now, TTL.code));
  return code;
}

export function takeAuthCode(
  db: Db,
  code: string,
  now: string,
): { status: 'ok'; row: AuthCodeRow } | { status: 'reused'; grantId: number } | { status: 'invalid' } {
  const hash = sha256(code);
  const r = db.prepare('SELECT * FROM oauth_codes WHERE hash = ?').get(hash) as
    | {
        hash: string;
        grant_id: number;
        client_id: string;
        redirect_uri: string;
        code_challenge: string;
        resource: string;
        expires_at: string;
        used_at: string | null;
      }
    | undefined;
  if (!r) return { status: 'invalid' };
  if (r.used_at !== null) return { status: 'reused', grantId: r.grant_id };
  if (r.expires_at <= now) return { status: 'invalid' };
  db.prepare('UPDATE oauth_codes SET used_at = ? WHERE hash = ?').run(now, hash);
  return {
    status: 'ok',
    row: {
      hash: r.hash,
      grantId: r.grant_id,
      clientId: r.client_id,
      redirectUri: r.redirect_uri,
      codeChallenge: r.code_challenge,
      resource: r.resource,
      expiresAt: r.expires_at,
      usedAt: now,
    },
  };
}

// ---- tokens ----

export interface TokenRecord {
  hash: string;
  grantId: number;
  kind: 'access' | 'refresh';
  expiresAt: string;
  replacedAt: string | null;
  replacedBy: string | null;
  grant: { scopes: HubScope[]; clientId: string; revokedAt: string | null };
}

function insertToken(
  db: Db,
  grantId: number,
  kind: 'access' | 'refresh',
  token: string,
  expiresAt: string,
  pairHash: string | null,
): string {
  const hash = sha256(token);
  db.prepare('INSERT INTO oauth_tokens(hash, grant_id, kind, expires_at, pair_hash) VALUES (?, ?, ?, ?, ?)').run(
    hash,
    grantId,
    kind,
    expiresAt,
    pairHash,
  );
  return hash;
}

function issuePair(db: Db, grantId: number, now: string): { access: string; refresh: string } {
  const refresh = rand('chub_rt_');
  const refreshHash = insertToken(db, grantId, 'refresh', refresh, plus(now, TTL.refreshIdle), null);
  const access = rand('chub_at_');
  insertToken(db, grantId, 'access', access, plus(now, TTL.access), refreshHash);
  return { access, refresh };
}

export function issueTokens(db: Db, grantId: number, withRefresh: boolean, now: string): { access: string; refresh: string | null } {
  return db.transaction(() => {
    if (withRefresh) return issuePair(db, grantId, now);
    const access = rand('chub_at_');
    insertToken(db, grantId, 'access', access, plus(now, TTL.access), null);
    return { access, refresh: null };
  })();
}

export function findToken(db: Db, token: string): TokenRecord | null {
  const r = db
    .prepare(
      `SELECT t.hash, t.grant_id, t.kind, t.expires_at, t.replaced_at, t.replaced_by,
              g.scopes, g.client_id, g.revoked_at
       FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id WHERE t.hash = ?`,
    )
    .get(sha256(token)) as
    | {
        hash: string;
        grant_id: number;
        kind: 'access' | 'refresh';
        expires_at: string;
        replaced_at: string | null;
        replaced_by: string | null;
        scopes: string;
        client_id: string;
        revoked_at: string | null;
      }
    | undefined;
  if (!r) return null;
  return {
    hash: r.hash,
    grantId: r.grant_id,
    kind: r.kind,
    expiresAt: r.expires_at,
    replacedAt: r.replaced_at,
    replacedBy: r.replaced_by,
    grant: { scopes: parseScopes(r.scopes), clientId: r.client_id, revokedAt: r.revoked_at },
  };
}

/** Expires a refresh token and the access token issued with it. */
export function revokePair(db: Db, refreshHash: string, now: string): void {
  db.prepare('UPDATE oauth_tokens SET expires_at = ? WHERE (hash = ? OR pair_hash = ?) AND expires_at > ?').run(
    now,
    refreshHash,
    refreshHash,
    now,
  );
}

/**
 * Replaces a refresh token with a fresh pair. The old one is kept, marked replaced, so a retry inside the
 * grace window can be told from theft. A retry also cancels the pair handed out for the lost response.
 */
export function rotateRefresh(db: Db, old: TokenRecord, now: string): { access: string; refresh: string } {
  return db.transaction(() => {
    if (old.replacedBy) revokePair(db, old.replacedBy, now);
    const pair = issuePair(db, old.grantId, now);
    const newRefreshHash = sha256(pair.refresh);
    db.prepare('UPDATE oauth_tokens SET replaced_at = COALESCE(replaced_at, ?), replaced_by = ? WHERE hash = ?').run(now, newRefreshHash, old.hash);
    return pair;
  })();
}
