import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db.js';
import { addToWaitlist, countWaitlist, listWaitlist, normalizeEmail, removeFromWaitlist, WAITLIST_MAX } from '../src/waitlist.js';

const NOW = '2026-11-15T00:00:00.000Z';
let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
});

describe('waitlist', () => {
  it('normalises: trims, lowercases, and refuses what is not an address', () => {
    expect(normalizeEmail('  Ada@Example.COM ')).toBe('ada@example.com');
    for (const bad of [null, '', 'ada', 'ada@', '@example.com', 'ada@example', 'a b@example.com', 'a@b@c.com', `${'a'.repeat(250)}@x.co`]) {
      expect(normalizeEmail(bad)).toBeNull();
    }
  });

  it('stores an address once', () => {
    expect(addToWaitlist(db, 'ada@example.com', NOW)).toBe('added');
    expect(addToWaitlist(db, 'ada@example.com', NOW)).toBe('exists');
    expect(countWaitlist(db)).toBe(1);
    expect(listWaitlist(db)).toEqual([{ email: 'ada@example.com', created_at: NOW }]);
  });

  it('stops at the limit', () => {
    const insert = db.prepare('INSERT INTO waitlist(email, created_at) VALUES (?, ?)');
    db.transaction(() => {
      for (let i = 0; i < WAITLIST_MAX; i++) insert.run(`u${i}@example.com`, NOW);
    })();
    expect(addToWaitlist(db, 'late@example.com', NOW)).toBe('full');
    expect(addToWaitlist(db, 'u1@example.com', NOW)).toBe('exists');
  });

  it('removes one address', () => {
    addToWaitlist(db, 'ada@example.com', NOW);
    expect(removeFromWaitlist(db, 'ada@example.com')).toBe(true);
    expect(removeFromWaitlist(db, 'ada@example.com')).toBe(false);
  });
});
