import type { Llm } from './llm.js';
import { applyReview } from './page-review.js';
import type { DigestBody, StatePage } from './summary-schema.js';
import { renderLines, splitParts } from './transcript.js';
import type { Message } from './types.js';

export const CHARS_PER_TOKEN = 2;
export const DEFAULT_MAX_INPUT_TOKENS = 60000;
export const REBUILD_AFTER_MS = 7 * 24 * 60 * 60_000;

export const EMPTY_DIGEST: DigestBody = { goal: 'Empty session: no conversation content.', done: [], decisions: [], open_items: [], key_refs: [] };

/** Digests a session, in parts when it is longer than maxChars, and merges the parts. */
export async function writeDigest(llm: Llm, s: { project: string; title: string; messages: Message[] }, maxChars: number): Promise<DigestBody> {
  const parts = splitParts(renderLines(s.messages), maxChars);
  if (parts.length === 0) return EMPTY_DIGEST;
  if (parts.length === 1) return llm.digest({ project: s.project, title: s.title, transcript: parts[0]!, part: null });
  const bodies: DigestBody[] = [];
  for (let i = 0; i < parts.length; i++) {
    bodies.push(await llm.digest({ project: s.project, title: s.title, transcript: parts[i]!, part: { index: i + 1, total: parts.length } }));
  }
  return llm.mergeDigests({ project: s.project, title: s.title, parts: bodies });
}

export interface PageDigest {
  session_id: string;
  title: string;
  date: string | null;
  text: string;
}

export interface PageInputs {
  project: string;
  page: { summary: string; body: string; rebuilt_at: string; dirty: boolean } | null;
  /** Every ok digest, oldest first. */
  digests: PageDigest[];
  /** The digests not yet on the page. */
  fresh: PageDigest[];
  now: string;
  maxChars: number;
  forceRebuild?: boolean;
  /** Told when the review pass fails and the page is kept as written. */
  onReviewSkipped?: (reason: string) => void;
}

/** The newest digests that fit under maxChars, newest first. */
function newestWithin(all: PageDigest[], maxChars: number): PageDigest[] {
  const chosen: PageDigest[] = [];
  let used = 0;
  for (let i = all.length - 1; i >= 0; i--) {
    const d = all[i]!;
    if (chosen.length > 0 && used + d.text.length > maxChars) break;
    chosen.push(d);
    used += d.text.length;
  }
  return chosen;
}

/**
 * A second look at a finished page against the newest digests, to drop open
 * items and state lines a session already settled. A failed review keeps the
 * page as written: it is an improvement, not a reason to lose the update.
 */
async function reviewPage(llm: Llm, project: string, page: StatePage, all: PageDigest[], maxChars: number, skipped?: (reason: string) => void): Promise<StatePage> {
  const shown = newestWithin(all, maxChars);
  try {
    const review = await llm.reviewState({ project, page, digests: shown });
    return applyReview(page, review, new Set(shown.map((d) => d.session_id)));
  } catch (e) {
    skipped?.(e instanceof Error ? e.message : String(e));
    return page;
  }
}

/**
 * Writes a project's state page: merges the fresh digests into the current
 * page, or rebuilds it from all digests when there is no page, it is flagged
 * dirty, it is older than a week, or a rebuild is forced. Null when the
 * project has no digests, so the caller removes the page.
 */
export async function buildStatePage(llm: Llm, inputs: PageInputs): Promise<{ page: StatePage; fullRebuild: boolean } | null> {
  const { project, page: current, digests, fresh, now, maxChars } = inputs;
  if (digests.length === 0) return null;
  const old = current ? Date.parse(now) - Date.parse(current.rebuilt_at) > REBUILD_AFTER_MS : false;
  const rebuild = !current || current.dirty || old || inputs.forceRebuild === true;

  if (current && !rebuild) {
    if (fresh.length === 0) return { page: { summary: current.summary, body: current.body }, fullRebuild: false };
    const merged = await llm.projectState({ project, mode: 'merge', previous: current.body, digests: fresh });
    return { page: await reviewPage(llm, project, merged, digests, maxChars, inputs.onReviewSkipped), fullRebuild: false };
  }

  // Newest first until the limit is reached, then back into oldest-first order.
  const chosen = newestWithin(digests, maxChars).reverse();
  const truncated = chosen.length < digests.length;
  const previous = truncated ? (current?.body ?? null) : null;
  const built = await llm.projectState({ project, mode: 'rebuild', previous, digests: chosen });
  return { page: await reviewPage(llm, project, built, digests, maxChars, inputs.onReviewSkipped), fullRebuild: true };
}
