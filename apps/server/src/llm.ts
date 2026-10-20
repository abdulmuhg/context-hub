import * as z from 'zod/v4';
import type { DigestBody } from './digest-store.js';
import type { PageReview } from './page-review.js';

const Item = z.object({
  text: z.string(),
  seq: z.number().int().nullable().describe('Position of the supporting message, from the [n] prefix, or null'),
});

export const DigestSchema = z.object({
  goal: z.string().describe('What the user was trying to achieve in this session, in one or two sentences'),
  done: z.array(Item).describe('What was actually done'),
  decisions: z
    .array(z.object({ what: z.string(), why: z.string(), seq: z.number().int().nullable() }))
    .describe('Decisions that were made, each with its reason'),
  open_items: z.array(Item).describe('What is unfinished, blocked or planned next'),
  key_refs: z.array(z.string()).describe('Important file paths, commands and links'),
});

export const StateSchema = z.object({
  summary: z.string().describe('One sentence: the current state of the project'),
  body: z.string().describe('The state page in Markdown'),
});

export type StatePage = z.infer<typeof StateSchema>;

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
  /** merge: fold one new digest into the previous page. rebuild: write the page from all digests. */
  mode: 'merge' | 'rebuild';
  previous: string | null;
  digests: { session_id: string; title: string; date: string | null; text: string }[];
}

export interface Llm {
  readonly model: string;
  digest(req: DigestRequest): Promise<DigestBody>;
  mergeDigests(req: { project: string; title: string; parts: DigestBody[] }): Promise<DigestBody>;
  projectState(req: StateRequest): Promise<StatePage>;
  /** Names lines on a finished page that the sessions show are settled, and rewrites the summary. */
  reviewState(req: ReviewRequest): Promise<PageReview>;
}

const Drop = z.object({
  item: z.number().int().describe('The number of the line, as given'),
  session_id: z.string().describe('The id of the session that shows it, exactly as given'),
});

export const ReviewSchema = z.object({
  drop_open: z.array(Drop).describe('Open items that a session shows are done, decided or no longer needed'),
  drop_current: z.array(Drop).describe('Current-state lines that a newer session contradicts'),
  summary: z.string().describe('One sentence of at most 25 words: where the project stands, written from the page without the dropped lines'),
});

export interface ReviewRequest {
  project: string;
  page: StatePage;
  /** The page's sources and any newer sessions, newest first. */
  digests: { session_id: string; title: string; date: string | null; text: string }[];
}
