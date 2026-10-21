import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db.js';
import { parseDailyBudgetUsd, priceMicroUsd, recordUsage, spendBetween, type UsageRecord } from '../src/usage.js';

const rec = (over: Partial<UsageRecord> = {}): UsageRecord => ({
  model: 'claude-haiku-5-5',
  kind: 'digest',
  project: 'p',
  input_tokens: 1000,
  output_tokens: 200,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  ...over,
});

describe('priceMicroUsd', () => {
  it('uses the low rate up to 100,000 input tokens', () => {
    // 100,000 x $0.10/M + 1,000 x $0.50/M = $0.0105
    expect(priceMicroUsd('claude-haiku-5-5', 100_000, 1_000)).toBe(10_500);
  });
  it('uses the high rate for the whole call above 100,000 input tokens', () => {
    // 100,001 x $0.50/M + 1,000 x $2.50/M
    expect(priceMicroUsd('claude-haiku-5-5', 100_001, 1_000)).toBe(Math.round(100_001 * 0.5 + 1_000 * 2.5));
  });
  it('gives null for an unknown model', () => {
    expect(priceMicroUsd('some-other-model', 1, 1)).toBeNull();
  });
});

describe('recordUsage', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(':memory:');
  });

  it('stores the counts and the price', () => {
    recordUsage(db, rec({ cache_read_tokens: 3, cache_write_tokens: 4 }), '2026-10-21T10:00:00.000Z');
    expect(db.prepare('SELECT * FROM model_usage').get()).toMatchObject({
      at: '2026-10-21T10:00:00.000Z',
      model: 'claude-haiku-5-5',
      kind: 'digest',
      project_key: 'p',
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_tokens: 3,
      cache_write_tokens: 4,
      cost_micro_usd: 200,
    });
  });

  it('stores null cost for an unknown model and counts its tokens', () => {
    recordUsage(db, rec({ model: 'x' }), '2026-10-21T10:00:00.000Z');
    expect(spendBetween(db, '2026-10-21T00:00:00.000Z', '2026-10-22T00:00:00.000Z')).toEqual({ calls: 1, input: 1000, output: 200, micro_usd: 0 });
  });

  it('prunes rows older than 90 days when a row is written', () => {
    recordUsage(db, rec(), '2026-07-01T00:00:00.000Z');
    recordUsage(db, rec(), '2026-08-01T00:00:00.000Z');
    recordUsage(db, rec(), '2026-10-21T00:00:00.000Z');
    expect((db.prepare('SELECT at FROM model_usage ORDER BY at').all() as { at: string }[]).map((r) => r.at)).toEqual(['2026-08-01T00:00:00.000Z', '2026-10-21T00:00:00.000Z']);
  });
});

describe('spendBetween', () => {
  it('sums a half-open range', () => {
    const db = openDb(':memory:');
    recordUsage(db, rec(), '2026-10-20T23:59:59.999Z');
    recordUsage(db, rec(), '2026-10-21T00:00:00.000Z');
    recordUsage(db, rec(), '2026-10-21T12:00:00.000Z');
    recordUsage(db, rec(), '2026-10-22T00:00:00.000Z');
    expect(spendBetween(db, '2026-10-21T00:00:00.000Z', '2026-10-22T00:00:00.000Z')).toEqual({ calls: 2, input: 2000, output: 400, micro_usd: 400 });
  });
  it('is all zeros when empty', () => {
    expect(spendBetween(openDb(':memory:'), 'a', 'z')).toEqual({ calls: 0, input: 0, output: 0, micro_usd: 0 });
  });
});

describe('parseDailyBudgetUsd', () => {
  it('is no limit when unset or empty', () => {
    expect(parseDailyBudgetUsd(undefined)).toBeNull();
    expect(parseDailyBudgetUsd('  ')).toBeNull();
  });
  it('accepts a positive number', () => {
    expect(parseDailyBudgetUsd('2.5')).toBe(2.5);
  });
  it.each(['0', '-1', 'abc', 'Infinity', 'NaN'])('rejects %s', (v) => {
    expect(() => parseDailyBudgetUsd(v)).toThrow('DIGEST_DAILY_BUDGET_USD must be a positive number of US dollars');
  });
});
