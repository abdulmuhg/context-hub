import type { Db } from './db.js';

export type UsageKind = 'digest' | 'merge' | 'state' | 'shorten' | 'review';

export interface UsageRecord {
  model: string;
  kind: UsageKind;
  project: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

interface Rate {
  /** US dollars per million tokens, which is the same number as micro-dollars per token. */
  input: number;
  output: number;
}

interface Price extends Rate {
  /** Above this many input tokens the whole call uses `over`. */
  step_tokens?: number;
  over?: Rate;
}

/** Checked against the Anthropic pricing page on 2026-10-21. */
const PRICES: Record<string, Price> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5, step_tokens: 100_000, over: { input: 0.5, output: 2.5 } },
};

export const PRICE_STEP_TOKENS = 100_000;
const KEEP_MS = 90 * 24 * 60 * 60 * 1000;

/** Micro-dollars for one call, or null for a model with no known price. */
export function priceMicroUsd(model: string, input: number, output: number): number | null {
  const p = PRICES[model];
  if (!p) return null;
  const r = p.step_tokens !== undefined && p.over && input > p.step_tokens ? p.over : p;
  return Math.round(input * r.input + output * r.output);
}

/** Saves one call and drops rows older than 90 days. */
export function recordUsage(db: Db, u: UsageRecord, now: string): void {
  const cutoff = new Date(Date.parse(now) - KEEP_MS).toISOString();
  db.transaction(() => {
    db.prepare('DELETE FROM model_usage WHERE at < ?').run(cutoff);
    db.prepare(
      `INSERT INTO model_usage(at, model, kind, project_key, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_micro_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(now, u.model, u.kind, u.project, u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens, priceMicroUsd(u.model, u.input_tokens, u.output_tokens));
  })();
}

export interface Spend {
  calls: number;
  input: number;
  output: number;
  micro_usd: number;
}

/** Spend in [fromIso, toIso). A call with no known price adds tokens but no cost. */
export function spendBetween(db: Db, fromIso: string, toIso: string): Spend {
  return db
    .prepare(
      `SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(output_tokens), 0) AS output,
              COALESCE(SUM(cost_micro_usd), 0) AS micro_usd
       FROM model_usage WHERE at >= ? AND at < ?`,
    )
    .get(fromIso, toIso) as Spend;
}
