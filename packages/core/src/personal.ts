export type Level = 'off' | 'warn' | 'partial' | 'full';

export interface PersonalEntry {
  label: string;
  value: string;
  level?: Level;
}

export interface PersonalConfig {
  card: Level;
  list: Level;
  entries: PersonalEntry[];
}

export function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return digits.length > 0 && sum % 10 === 0;
}

/** A run of digit groups joined by single spaces or dashes. */
const DIGIT_RUN_RE = /\d+(?:[ -]\d+)*/g;
const DIGITS_AND_SEPARATORS = /^[\d\s().+-]+$/;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function entryRegex(value: string): RegExp {
  const trimmed = value.trim();
  const digits = value.replace(/\D/g, '');
  if (DIGITS_AND_SEPARATORS.test(value) && digits.length >= 4) {
    // Compare digits only: any run of separators may sit between them.
    const body = digits.split('').join('[\\s().-]*');
    const plus = trimmed.startsWith('+') ? '\\+[\\s().-]*' : '';
    return new RegExp('(?<![\\d+])' + plus + body + '(?!\\d)', 'g');
  }
  return new RegExp(escapeRegex(value), 'gi');
}

/** `compact` is the matched value without separators; `name` labels the marker. */
function mask(level: Level, compact: string, partialPrefix: string, name: string): string | null {
  if (level === 'full') return `[REDACTED:${name}]`;
  if (level === 'partial') {
    if (compact.length < 8) return `[REDACTED:${name}]`;
    return `[${partialPrefix} ····${compact.slice(-4)}]`;
  }
  return null; // warn: leave unchanged
}

const STRENGTH: Record<Level, number> = { off: 0, warn: 1, partial: 2, full: 3 };

interface Hit {
  start: number;
  end: number;
  level: Level;
  finding: string;
  replacement: string | null; // null: leave unchanged
}

/**
 * Find card numbers inside one separator-joined digit run, on group boundaries.
 * Only windows of 13-19 digits are examined (at most 19 groups per start), and
 * windows are taken longest (most groups) first, then leftmost, skipping any
 * that overlap one already taken.
 */
function cardWindows(
  groups: { start: number; end: number; digits: string }[],
): { start: number; end: number; digits: string }[] {
  const cands: { s: number; len: number; digits: string }[] = [];
  for (let s = 0; s < groups.length; s++) {
    let total = 0;
    let digits = '';
    for (let e = s; e < groups.length; e++) {
      total += groups[e]!.digits.length;
      if (total > 19) break;
      digits += groups[e]!.digits;
      if (total >= 13 && luhn(digits)) cands.push({ s, len: e - s + 1, digits });
    }
  }
  cands.sort((a, b) => b.len - a.len || a.s - b.s);
  const taken = new Array<boolean>(groups.length).fill(false);
  const out: { start: number; end: number; digits: string }[] = [];
  for (const c of cands) {
    let free = true;
    for (let i = c.s; i < c.s + c.len; i++) {
      if (taken[i]) {
        free = false;
        break;
      }
    }
    if (!free) continue;
    for (let i = c.s; i < c.s + c.len; i++) taken[i] = true;
    out.push({ start: groups[c.s]!.start, end: groups[c.s + c.len - 1]!.end, digits: c.digits });
  }
  return out;
}

export function filterPersonal(
  text: string,
  cfg: PersonalConfig,
): { text: string; findings: Record<string, number> } {
  const hits: Hit[] = [];

  for (const entry of cfg.entries) {
    const level = entry.level ?? cfg.list;
    if (level === 'off' || entry.value.trim() === '') continue;
    const numeric = DIGITS_AND_SEPARATORS.test(entry.value);
    for (const m of text.matchAll(entryRegex(entry.value))) {
      if (m[0].length === 0) continue;
      const match = m[0];
      const compact = numeric ? match.replace(/\D/g, '') : match;
      hits.push({
        start: m.index,
        end: m.index + match.length,
        level,
        finding: entry.label,
        replacement: mask(level, compact, `PERSONAL:${entry.label}`, entry.label),
      });
    }
  }

  if (cfg.card !== 'off') {
    for (const run of text.matchAll(DIGIT_RUN_RE)) {
      const groups: { start: number; end: number; digits: string }[] = [];
      for (const g of run[0].matchAll(/\d+/g)) {
        const start = run.index + g.index;
        groups.push({ start, end: start + g[0].length, digits: g[0] });
      }
      const found = cardWindows(groups);
      for (const c of found) {
        hits.push({
          start: c.start,
          end: c.end,
          level: cfg.card,
          finding: 'card',
          replacement: mask(cfg.card, c.digits, 'CARD', 'card'),
        });
      }
    }
  }

  // A hit that rewrites text beats a warn hit it overlaps. Then the longest
  // match wins; on a tie the stronger level wins; then the leftmost.
  hits.sort(
    (a, b) =>
      Number(b.replacement !== null) - Number(a.replacement !== null) ||
      b.end - b.start - (a.end - a.start) ||
      STRENGTH[b.level] - STRENGTH[a.level] ||
      a.start - b.start,
  );
  const accepted: Hit[] = [];
  for (const h of hits) {
    if (!accepted.some((a) => h.start < a.end && a.start < h.end)) accepted.push(h);
  }
  accepted.sort((a, b) => a.start - b.start);

  const findings: Record<string, number> = {};
  let out = '';
  let pos = 0;
  for (const h of accepted) {
    findings[h.finding] = (findings[h.finding] ?? 0) + 1;
    out += text.slice(pos, h.start) + (h.replacement ?? text.slice(h.start, h.end));
    pos = h.end;
  }
  out += text.slice(pos);

  return { text: out, findings };
}
