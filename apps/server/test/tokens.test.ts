import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { AuthLimiter } from '../src/ratelimit.js';
import { createToken, listTokens, revokeToken, verifyToken } from '../src/tokens.js';

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
