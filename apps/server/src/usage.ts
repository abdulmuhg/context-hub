import type { UsageKind } from '@context-hub/core';
import type { Db } from './db.js';

export type { UsageKind };

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

/** The daily limit from the environment: a positive number of US dollars, or null when unset. */
export function parseDailyBudgetUsd(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error('DIGEST_DAILY_BUDGET_USD must be a positive number of US dollars');
  return n;
}

/** True when today's (UTC) spend has reached the limit. */
export function budgetReached(db: Db, limitMicroUsd: number, now: string): boolean {
  const today = utcDayStart(now);
  return spendBetween(db, today, addDays(today, 1)).micro_usd >= limitMicroUsd;
}

/** Money for display: 2 decimals, or 4 when the total is under $0.01 but not zero. */
export function formatUsd(microUsd: number): string {
  const dollars = microUsd / 1_000_000;
  return `$${dollars.toFixed(microUsd > 0 && microUsd < 10_000 ? 4 : 2)}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Start of the UTC day containing `nowIso`, as an ISO time. */
export function utcDayStart(nowIso: string): string {
  const d = new Date(nowIso);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

export const addDays = (iso: string, n: number): string => new Date(Date.parse(iso) + n * DAY_MS).toISOString();

export interface Totals extends Spend {
  /** Calls whose cost is known. When 0 for a non-empty group, the cost is shown as unknown. */
  priced: number;
}

export interface UsageReport {
  /** Oldest first, one entry per UTC day. */
  days: (Totals & { day: string })[];
  by_kind: (Totals & { name: string })[];
  by_project: (Totals & { name: string })[];
  over_step: number;
}

const TOTALS = `COUNT(*) AS calls, COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(output_tokens), 0) AS output,
                COALESCE(SUM(cost_micro_usd), 0) AS micro_usd, COUNT(cost_micro_usd) AS priced`;

/** The last `days` UTC days up to and including today's. */
export function usageReport(db: Db, days: number, now: string): UsageReport {
  const today = utcDayStart(now);
  const from = addDays(today, -(days - 1));
  const to = addDays(today, 1);
  const grouped = (expr: string): (Totals & { name: string })[] =>
    db
      .prepare(`SELECT ${expr} AS name, ${TOTALS} FROM model_usage WHERE at >= ? AND at < ? GROUP BY name ORDER BY micro_usd DESC, input DESC, name`)
      .all(from, to) as (Totals & { name: string })[];
  const perDay = new Map(
    (db.prepare(`SELECT substr(at, 1, 10) AS day, ${TOTALS} FROM model_usage WHERE at >= ? AND at < ? GROUP BY day`).all(from, to) as (Totals & { day: string })[]).map((r) => [r.day, r]),
  );
  const list: UsageReport['days'] = [];
  for (let i = 0; i < days; i++) {
    const day = addDays(from, i).slice(0, 10);
    list.push(perDay.get(day) ?? { day, calls: 0, input: 0, output: 0, micro_usd: 0, priced: 0 });
  }
  const over = db.prepare('SELECT COUNT(*) AS n FROM model_usage WHERE at >= ? AND at < ? AND input_tokens > ?').get(from, to, PRICE_STEP_TOKENS) as { n: number };
  return { days: list, by_kind: grouped('kind'), by_project: grouped("COALESCE(project_key, '(none)')"), over_step: over.n };
}
