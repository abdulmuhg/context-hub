import type * as z from 'zod/v4';
import { CURRENT_STATE, OPEN_ITEMS, sectionBullets, type PageReview } from './page-review.js';
import { cutToSections, DIGEST_SYSTEM, MERGE_SYSTEM, REVIEW_SYSTEM, STATE_HARD_WORDS, STATE_SYSTEM, wordCount } from './summary-prompts.js';
import { DigestSchema, ReviewSchema, StateSchema, type DigestBody, type StatePage } from './summary-schema.js';
import { renderDigest } from './transcript.js';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type UsageKind = 'digest' | 'merge' | 'state' | 'shorten' | 'review';

/** The model declined the request. Retrying the same input would decline again. */
export class LlmRefusal extends Error {
  constructor(public readonly category: string) {
    super(`the model declined this request (${category})`);
  }
}

export interface DigestRequest {
  project: string;
  title: string;
  /** Numbered transcript lines, already within the size limit. */
  transcript: string;
  /** Set when the session was too long for one request. */
  part: { index: number; total: number } | null;
}

export interface StateRequest {
  project: string;
  /** merge: fold the new digests into the previous page. rebuild: write the page from all digests. */
  mode: 'merge' | 'rebuild';
  previous: string | null;
  digests: { session_id: string; title: string; date: string | null; text: string }[];
}

export interface ReviewRequest {
  project: string;
  page: StatePage;
  /** The page's sources and any newer sessions, newest first. */
  digests: { session_id: string; title: string; date: string | null; text: string }[];
  /** Git and PR facts for the project, when the caller has a checkout to read them from. */
  git?: { text: string; as_of: string };
}

export interface Llm {
  readonly model: string;
  digest(req: DigestRequest): Promise<DigestBody>;
  mergeDigests(req: { project: string; title: string; parts: DigestBody[] }): Promise<DigestBody>;
  projectState(req: StateRequest): Promise<StatePage>;
  /** Names lines on a finished page that the sessions show are settled, and rewrites the summary. */
  reviewState(req: ReviewRequest): Promise<PageReview>;
}

export interface AskCall {
  system: string;
  user: string;
  schema: z.ZodType;
  kind: UsageKind;
  project: string | null;
}

/** Builds the prompts; a subclass supplies the one call that sends them to a model. */
export abstract class PromptedLlm implements Llm {
  abstract readonly model: string;

  protected abstract ask<T>(call: AskCall): Promise<T>;

  digest(req: DigestRequest): Promise<DigestBody> {
    const part = req.part ? `\nThis is part ${req.part.index} of ${req.part.total} of a long session. Digest only this part.` : '';
    const user = `Project: ${req.project}\nSession title: ${req.title}${part}\n\n<transcript>\n${req.transcript}\n</transcript>`;
    return this.ask<DigestBody>({ system: DIGEST_SYSTEM, user, schema: DigestSchema, kind: 'digest', project: req.project });
  }

  mergeDigests(req: { project: string; title: string; parts: DigestBody[] }): Promise<DigestBody> {
    const parts = req.parts.map((p, i) => `<part number="${i + 1}">\n${renderDigest(p)}\n</part>`).join('\n');
    return this.ask<DigestBody>({
      system: MERGE_SYSTEM,
      user: `Project: ${req.project}\nSession title: ${req.title}\n\n${parts}`,
      schema: DigestSchema,
      kind: 'merge',
      project: req.project,
    });
  }

  async projectState(req: StateRequest): Promise<StatePage> {
    const digests = req.digests
      .map((d) => `<session id="${d.session_id}" date="${d.date ?? 'unknown'}" title="${d.title.replace(/"/g, "'")}">\n${d.text}\n</session>`)
      .join('\n');
    const task =
      req.mode === 'merge'
        ? 'Fold the new session digests below into the previous page. The result must still fit the length limits: make room by dropping the oldest or least important entries, not by exceeding them.'
        : 'Write the page from scratch from the session digests below, which are in order from oldest to newest.';
    const previous = req.previous === null ? '' : `\n<previous_page>\n${req.previous}\n</previous_page>\n`;
    const page = await this.ask<StatePage>({
      system: STATE_SYSTEM,
      user: `Project: ${req.project}\n${task}\n${previous}\n${digests}`,
      schema: StateSchema,
      kind: 'state',
      project: req.project,
    });
    if (wordCount(page.body) <= STATE_HARD_WORDS) return page;

    // Merging one digest at a time made pages grow without bound in practice.
    // Ask once for a shorter version; if that is still too long, cut it here
    // so the page can never keep growing.
    const shorter = await this.ask<StatePage>({
      system: STATE_SYSTEM,
      user: `Project: ${req.project}\nThe page below is too long. Rewrite it to fit the limits: under 600 words in total, with the per-section limits. Keep what someone continuing the project needs most.\n\n<page>\n${page.body}\n</page>`,
      schema: StateSchema,
      kind: 'shorten',
      project: req.project,
    });
    return wordCount(shorter.body) <= STATE_HARD_WORDS ? shorter : { summary: shorter.summary, body: cutToSections(shorter.body, STATE_HARD_WORDS) };
  }

  reviewState(req: ReviewRequest): Promise<PageReview> {
    const numbered = (heading: string) =>
      sectionBullets(req.page.body, heading)
        .map((line, i) => `${i + 1}. ${line}`)
        .join('\n') || '(none)';
    const digests = req.digests
      .map((d) => `<session id="${d.session_id}" date="${d.date ?? 'unknown'}" title="${d.title.replace(/"/g, "'")}">\n${d.text}\n</session>`)
      .join('\n');
    const user = [
      `Project: ${req.project}`,
      `<open_items>\n${numbered(OPEN_ITEMS)}\n</open_items>`,
      `<current_state>\n${numbered(CURRENT_STATE)}\n</current_state>`,
      `<page>\n${req.page.body}\n</page>`,
      ...(req.git ? [`<git as_of="${req.git.as_of}">\n${req.git.text}\n</git>`] : []),
      `Session digests, newest first:\n${digests || '(none)'}`,
    ].join('\n\n');
    return this.ask<PageReview>({ system: REVIEW_SYSTEM, user, schema: ReviewSchema, kind: 'review', project: req.project });
  }
}
