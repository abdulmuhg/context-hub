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

const CARD_RE = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g;
const DIGITS_AND_SEPARATORS = /^[\d\s().+-]+$/;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function entryRegex(value: string): RegExp {
  const digits = value.replace(/\D/g, '');
  if (DIGITS_AND_SEPARATORS.test(value) && digits.length >= 4) {
    // Compare digits only: any run of separators may sit between them.
    return new RegExp('(?<![\\d+])' + digits.split('').join('[\\s().-]*') + '(?!\\d)', 'g');
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

export function filterPersonal(
  text: string,
  cfg: PersonalConfig,
): { text: string; findings: Record<string, number> } {
  const findings: Record<string, number> = {};
  let out = text;

  for (const entry of cfg.entries) {
    const level = entry.level ?? cfg.list;
    if (level === 'off' || entry.value.trim() === '') continue;
    const numeric = DIGITS_AND_SEPARATORS.test(entry.value);
    out = out.replace(entryRegex(entry.value), (match) => {
      findings[entry.label] = (findings[entry.label] ?? 0) + 1;
      const compact = numeric ? match.replace(/\D/g, '') : match;
      return mask(level, compact, `PERSONAL:${entry.label}`, entry.label) ?? match;
    });
  }

  if (cfg.card !== 'off') {
    out = out.replace(CARD_RE, (match) => {
      const digits = match.replace(/\D/g, '');
      if (digits.length < 13 || digits.length > 19 || !luhn(digits)) return match;
      findings.card = (findings.card ?? 0) + 1;
      return mask(cfg.card, digits, 'CARD', 'card') ?? match;
    });
  }

  return { text: out, findings };
}
