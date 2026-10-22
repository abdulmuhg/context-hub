import type { Llm } from './llm.js';
import { applyReview, GIT_EVIDENCE, splitGitSection } from './page-review.js';
import type { DigestBody, StatePage } from './summary-schema.js';
import { renderLines, splitParts } from './transcript.js';
import type { Message } from './types.js';

export const CHARS_PER_TOKEN = 2;
export const DEFAULT_MAX_INPUT_TOKENS = 60000;
export const REBUILD_AFTER_MS = 7 * 24 * 60 * 60_000;

export const EMPTY_DIGEST: DigestBody = { goal: 'Empty session: no conversation content.', done: [], decisions: [], open_items: [], key_refs: [] };

/** Digests a session, in parts when it is longer than maxChars, and merges the parts. onPart is called before each part of a long one. */
export async function writeDigest(
  llm: Llm,
  s: { project: string; title: string; messages: Message[] },
  maxChars: number,
  onPart?: (index: number, total: number) => void,
): Promise<DigestBody> {
  const parts = splitParts(renderLines(s.messages), maxChars);
  if (parts.length === 0) return EMPTY_DIGEST;
  if (parts.length === 1) return llm.digest({ project: s.project, title: s.title, transcript: parts[0]!, part: null });
  const bodies: DigestBody[] = [];
  for (let i = 0; i < parts.length; i++) {
    onPart?.(i + 1, parts.length);
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
  /** Git facts for the review, and the "## Git" section to end the page with. Without it the page keeps its old section. */
  git?: { facts: string; as_of: string; section: string };
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
async function reviewPage(
  llm: Llm,
  project: string,
  page: StatePage,
  all: PageDigest[],
  maxChars: number,
  git: PageInputs['git'],
  skipped?: (reason: string) => void,
): Promise<StatePage> {
  const shown = newestWithin(all, maxChars);
  try {
    const review = await llm.reviewState({ project, page, digests: shown, ...(git ? { git: { text: git.facts, as_of: git.as_of } } : {}) });
    const ids = new Set(shown.map((d) => d.session_id));
    if (git) ids.add(GIT_EVIDENCE);
    return applyReview(page, review, ids);
  } catch (e) {
    skipped?.(e instanceof Error ? e.message : String(e));
    return page;
  }
}

/**
 * Writes a project's state page: merges the fresh digests into the current
 * page, or rebuilds it from all digests when there is no page, it is flagged
 * dirty, it is older than a week, or a rebuild is forced. Null when the
 * project has no digests, so the caller removes the page. With git facts, a
 * page with nothing new is still reviewed, against git alone. The "## Git"
 * section never reaches a model: it is taken off first and a section is
 * attached at the end, the new one or else the old one.
 */
export async function buildStatePage(llm: Llm, inputs: PageInputs): Promise<{ page: StatePage; fullRebuild: boolean } | null> {
  const { project, page: stored, digests, fresh, now, maxChars, git } = inputs;
  if (digests.length === 0) return null;
  const split = stored ? splitGitSection(stored.body) : null;
  const current = stored && split ? { ...stored, body: split.body } : null;
  const attach = (page: StatePage): StatePage => {
    const section = git?.section ?? split?.section ?? null;
    return section === null ? page : { summary: page.summary, body: `${page.body}\n\n${section}` };
  };
  const old = current ? Date.parse(now) - Date.parse(current.rebuilt_at) > REBUILD_AFTER_MS : false;
  const rebuild = !current || current.dirty || old || inputs.forceRebuild === true;

  if (current && !rebuild) {
    if (fresh.length === 0) {
      if (!git) return { page: { summary: current.summary, body: stored!.body }, fullRebuild: false };
      const reviewed = await reviewPage(llm, project, { summary: current.summary, body: current.body }, [], maxChars, git, inputs.onReviewSkipped);
      return { page: attach(reviewed), fullRebuild: false };
    }
    const merged = await llm.projectState({ project, mode: 'merge', previous: current.body, digests: fresh });
    return { page: attach(await reviewPage(llm, project, merged, digests, maxChars, git, inputs.onReviewSkipped)), fullRebuild: false };
  }

  // Newest first until the limit is reached, then back into oldest-first order.
  const chosen = newestWithin(digests, maxChars).reverse();
  const truncated = chosen.length < digests.length;
  const previous = truncated ? (current?.body ?? null) : null;
  const built = await llm.projectState({ project, mode: 'rebuild', previous, digests: chosen });
  return { page: attach(await reviewPage(llm, project, built, digests, maxChars, git, inputs.onReviewSkipped)), fullRebuild: true };
}
