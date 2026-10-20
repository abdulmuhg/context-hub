import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { AuthLimiter } from '../src/ratelimit.js';
import { createGrant, issueTokens, revokeGrant } from '../src/oauth/store.js';
import { actorFor, checkCredential, createToken, listTokens, revokeToken, verifyToken } from '../src/tokens.js';

const T0 = '2026-10-11T00:00:00.000Z';
const T1 = '2026-10-11T01:00:00.000Z';

describe('tokens', () => {
  it('creates a token that verifies with its scope', () => {
    const db = openDb(':memory:');
    const { id, token } = createToken(db, 'collector-pc', 'ingest', T0);
    expect(token).toMatch(/^chub_[A-Za-z0-9_-]{40,}$/);
    expect(verifyToken(db, token, T1)).toEqual({ id, scope: 'ingest' });
  });

  it('stores only a hash, never the token', () => {
    const db = openDb(':memory:');
    const { token } = createToken(db, 'x', 'read', T0);
    const dump = JSON.stringify(db.prepare('SELECT * FROM tokens').all());
    expect(dump).not.toContain(token);
    expect(dump).toMatch(/[0-9a-f]{64}/);
  });

  it('rejects an unknown, empty or revoked token', () => {
    const db = openDb(':memory:');
    const { id, token } = createToken(db, 'x', 'read', T0);
    expect(verifyToken(db, 'chub_nope', T1)).toBeNull();
    expect(verifyToken(db, '', T1)).toBeNull();
    expect(revokeToken(db, id, T1)).toBe(true);
    expect(verifyToken(db, token, T1)).toBeNull();
  });

  it('revoke returns false for an unknown or already revoked id', () => {
    const db = openDb(':memory:');
    const { id } = createToken(db, 'x', 'read', T0);
    expect(revokeToken(db, 999, T1)).toBe(false);
    expect(revokeToken(db, id, T1)).toBe(true);
    expect(revokeToken(db, id, T1)).toBe(false);
  });

  it('lists tokens with last-used time and without hashes', () => {
    const db = openDb(':memory:');
    const a = createToken(db, 'collector', 'ingest', T0);
    createToken(db, 'claude-code', 'read', T0);
    verifyToken(db, a.token, T1);
    const rows = listTokens(db);
    expect(rows.map((r) => [r.label, r.scope, r.last_used_at])).toEqual([
      ['collector', 'ingest', T1],
      ['claude-code', 'read', null],
    ]);
    expect(Object.keys(rows[0]!)).not.toContain('hash');
  });

  it('two tokens are never equal', () => {
    const db = openDb(':memory:');
    expect(createToken(db, 'a', 'read', T0).token).not.toBe(createToken(db, 'b', 'read', T0).token);
  });
});

describe('AuthLimiter', () => {
  const MIN = 60_000;

  it('blocks an address after 10 failures inside 5 minutes, for 15 minutes', () => {
    let now = 0;
    const limiter = new AuthLimiter(() => now);
    for (let i = 0; i < 9; i++) limiter.recordFailure('1.1.1.1');
    expect(limiter.isBlocked('1.1.1.1')).toBe(false);
    limiter.recordFailure('1.1.1.1');
    expect(limiter.isBlocked('1.1.1.1')).toBe(true);
    now += 15 * MIN - 1;
    expect(limiter.isBlocked('1.1.1.1')).toBe(true);
    now += 2;
    expect(limiter.isBlocked('1.1.1.1')).toBe(false);
  });

  it('does not block when the failures are spread over more than 5 minutes', () => {
    let now = 0;
    const limiter = new AuthLimiter(() => now);
    for (let i = 0; i < 12; i++) {
      limiter.recordFailure('1.1.1.1');
      now += MIN;
    }
    expect(limiter.isBlocked('1.1.1.1')).toBe(false);
  });

  it('tracks each address separately', () => {
    const limiter = new AuthLimiter(() => 0);
    for (let i = 0; i < 10; i++) limiter.recordFailure('1.1.1.1');
    expect(limiter.isBlocked('2.2.2.2')).toBe(false);
  });
});

describe('AuthLimiter: memory bound', () => {
  it('does not grow without limit when every failure comes from a new address', () => {
    const limiter = new AuthLimiter(() => 0);
    for (let i = 0; i < 25000; i++) limiter.recordFailure(`10.${i >> 16}.${(i >> 8) & 255}.${i & 255}`);
    expect(limiter.size()).toBeLessThanOrEqual(10000);
  });

  it('still blocks a repeat offender while under that bound', () => {
    const limiter = new AuthLimiter(() => 0);
    for (let i = 0; i < 9000; i++) limiter.recordFailure(`a${i}`);
    for (let i = 0; i < 10; i++) limiter.recordFailure('9.9.9.9');
    expect(limiter.isBlocked('9.9.9.9')).toBe(true);
  });
});

describe('checkCredential', () => {
  const T2 = '2026-10-11T03:00:00.000Z'; // past the one-hour access lifetime

  it('accepts a live bearer token with its scope', () => {
    const db = openDb(':memory:');
    const { id, token } = createToken(db, 'x', 'read', T0);
    expect(checkCredential(db, token, T1)).toEqual({ kind: 'bearer', scope: 'read', id, label: 'x' });
  });

  it('accepts a live OAuth access token with its grant and scopes', () => {
    const db = openDb(':memory:');
    const grantId = createGrant(db, { clientId: 'c', clientName: 'Claude', scopes: ['hub.read'] }, T0);
    const { access } = issueTokens(db, grantId, false, T0);
    expect(checkCredential(db, access, '2026-10-11T00:30:00.000Z')).toEqual({
      kind: 'oauth',
      grantId,
      scopes: ['hub.read'],
      clientName: 'Claude',
    });
  });

  it("is 'dead' for a revoked bearer, an expired access token, or one whose grant is revoked", () => {
    const db = openDb(':memory:');
    const b = createToken(db, 'x', 'read', T0);
    revokeToken(db, b.id, T0);
    expect(checkCredential(db, b.token, T1)).toBe('dead');
    const grantId = createGrant(db, { clientId: 'c', clientName: 'Claude', scopes: ['hub.read'] }, T0);
    const { access } = issueTokens(db, grantId, false, T0);
    expect(checkCredential(db, access, T2)).toBe('dead');
    const g2 = createGrant(db, { clientId: 'c', clientName: 'Claude', scopes: ['hub.read'] }, T0);
    const live = issueTokens(db, g2, false, T0).access;
    revokeGrant(db, g2, T0);
    expect(checkCredential(db, live, T0)).toBe('dead');
  });

  it('is null for an unknown token, an empty one, or a refresh token', () => {
    const db = openDb(':memory:');
    const grantId = createGrant(db, { clientId: 'c', clientName: 'Claude', scopes: ['hub.read'] }, T0);
    const { refresh } = issueTokens(db, grantId, true, T0);
    expect(checkCredential(db, 'chub_nope', T1)).toBeNull();
    expect(checkCredential(db, '', T1)).toBeNull();
    expect(checkCredential(db, refresh!, T0)).toBeNull();
  });

  it('still accepts a legacy bearer token whose random part happens to start like an OAuth prefix', () => {
    const db = openDb(':memory:');
    for (const raw of ['chub_at_LegacyLooksLikeOAuth0123456789abcdefghijk', 'chub_rt_LegacyLooksLikeOAuth0123456789abcdefghijk']) {
      db.prepare('INSERT INTO tokens(label, scope, hash, created_at) VALUES (?, ?, ?, ?)').run(
        'legacy',
        'read',
        createHash('sha256').update(raw).digest('hex'),
        T0,
      );
      expect(checkCredential(db, raw, T1)).toMatchObject({ kind: 'bearer', scope: 'read', label: 'legacy' });
    }
    expect(checkCredential(db, 'chub_at_unknown', T1)).toBeNull();
    expect(checkCredential(db, 'chub_rt_unknown', T1)).toBeNull();
  });
});

describe('actorFor', () => {
  it('names an ingest token as the PC, a read token by label, and an OAuth grant by its client', () => {
    expect(actorFor({ kind: 'bearer', scope: 'ingest', id: 1, label: 'collector' })).toBe('your PC (collector)');
    expect(actorFor({ kind: 'bearer', scope: 'read', id: 2, label: 'assistant' })).toBe('read token: assistant');
    expect(actorFor({ kind: 'oauth', grantId: 3, scopes: ['hub.read'], clientName: 'claude.ai' })).toBe('claude.ai');
  });
});
