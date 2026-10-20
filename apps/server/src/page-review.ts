import type { StatePage } from './llm.js';

/**
 * A second look at a finished state page. The page is written in one pass, and
 * in that pass the model often keeps an open item or a state line that a newer
 * session already settled. The review only names what to drop and which
 * session shows it; the dropping is done here, so it cannot rewrite anything
 * else on the page.
 */
export interface PageReview {
  /** 1-based positions in "## Open items" that a session shows are settled. */
  drop_open: { item: number; session_id: string }[];
  /** 1-based positions in "## Current state" that a newer session contradicts. */
  drop_current: { item: number; session_id: string }[];
  /** One sentence written from the corrected page. Empty keeps the old one. */
  summary: string;
}

export const OPEN_ITEMS = 'Open items';
export const CURRENT_STATE = 'Current state';

interface Section {
  /** Line index of the heading. */
  start: number;
  /** Line index after the section's last line. */
  end: number;
}

function findSection(lines: string[], heading: string): Section | null {
  const start = lines.findIndex((l) => l.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && !lines[end]!.startsWith('## ')) end++;
  return { start, end };
}

/** Each bullet as [first line, last line], counting indented continuation lines. */
function bulletRanges(lines: string[], section: Section): [number, number][] {
  const ranges: [number, number][] = [];
  for (let i = section.start + 1; i < section.end; i++) {
    if (/^[-*] /.test(lines[i]!)) ranges.push([i, i]);
    else if (ranges.length > 0 && /^\s+\S/.test(lines[i]!)) ranges[ranges.length - 1]![1] = i;
  }
  return ranges;
}

/** The bullets of one section, as single lines, in order. */
export function sectionBullets(body: string, heading: string): string[] {
  const lines = body.split('\n');
  const section = findSection(lines, heading);
  if (!section) return [];
  return bulletRanges(lines, section).map(([a, b]) =>
    lines
      .slice(a, b + 1)
      .map((l) => l.trim())
      .join(' ')
      .replace(/^[-*] /, ''),
  );
}

function dropBullets(body: string, heading: string, positions: Set<number>): string {
  if (positions.size === 0) return body;
  const lines = body.split('\n');
  const section = findSection(lines, heading);
  if (!section) return body;
  const drop = new Set<number>();
  bulletRanges(lines, section).forEach(([a, b], i) => {
    if (positions.has(i + 1)) for (let l = a; l <= b; l++) drop.add(l);
  });
  return lines.filter((_, i) => !drop.has(i)).join('\n');
}

/**
 * Applies a review. An entry is ignored unless it names a position that exists
 * and a session the review was actually shown, so a confused answer cannot
 * empty a section or cite evidence it never saw.
 */
export function applyReview(page: StatePage, review: PageReview, shown: ReadonlySet<string>): StatePage {
  const valid = (entries: PageReview['drop_open'], count: number) =>
    new Set(entries.filter((e) => Number.isInteger(e.item) && e.item >= 1 && e.item <= count && shown.has(e.session_id)).map((e) => e.item));
  const open = valid(review.drop_open, sectionBullets(page.body, OPEN_ITEMS).length);
  const current = valid(review.drop_current, sectionBullets(page.body, CURRENT_STATE).length);
  let body = dropBullets(page.body, OPEN_ITEMS, open);
  body = dropBullets(body, CURRENT_STATE, current);
  const summary = review.summary.trim() === '' ? page.summary : review.summary.trim();
  return { summary, body };
}
