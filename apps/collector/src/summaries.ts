import { CHARS_PER_TOKEN, DEFAULT_MAX_INPUT_TOKENS, LlmRefusal, writeDigest, type HashedSession, type Llm, type UploadDigest } from '@context-hub/core';
import { ClaudeSignInError, UsageLimitError } from './claude-llm.js';
import { SUMMARY_CAP } from './config.js';
import { getSession, listProjectDigests, putDigest, type Remote } from './upload.js';

/** A long session is digested in parts of this many characters, as the server does. */
export const MAX_CHARS = DEFAULT_MAX_INPUT_TOKENS * CHARS_PER_TOKEN;

/** How many more summaries this run may write, and why it stopped writing them, if it did. */
export interface Budget {
  /** Null when the cap is lifted (--all). */
  left: number | null;
  /** Set when Claude cannot be used for the rest of the run (usage limit, not signed in). The text says why. */
  stopped: string | null;
}

export const newBudget = (all: boolean | undefined): Budget => ({ left: all ? null : SUMMARY_CAP, stopped: null });

export const budgetOpen = (b: Budget): boolean => b.stopped === null && (b.left === null || b.left > 0);

export function spend(b: Budget): void {
  if (b.left !== null) b.left--;
}

const clock = (iso: string): string => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** The reason a failed model call ends the run's model work, or null for a failure of that one session only. */
export function stopReason(e: unknown): string | null {
  if (e instanceof UsageLimitError) return e.resetsAt === null ? 'Claude usage limit reached' : `Claude usage limit reached (resets ${clock(e.resetsAt)})`;
  if (e instanceof ClaudeSignInError) return 'Claude Code is not signed in. Run: claude';
  return null;
}

/**
 * Writes the summary to send with a session. A refusal does not change on
 * retry, so it is returned as the outcome. Every other failure is thrown.
 */
export async function summarize(llm: Llm, session: HashedSession, maxChars: number = MAX_CHARS): Promise<UploadDigest> {
  try {
    const body = await writeDigest(llm, { project: session.project_key, title: session.title, messages: session.messages }, maxChars);
    return { body, model: llm.model };
  } catch (e) {
    if (e instanceof LlmRefusal) return { refused: e.category, model: llm.model };
    throw e;
  }
}

export interface SessionRef {
  project: string;
  session: string;
}

/**
 * Writes the summaries the hub still owes after a re-clean: the old summary was
 * taken away, so the session waits for a new one. Each is uploaded on its own.
 */
export async function catchUpOwed(
  remote: Remote,
  llm: Llm,
  projects: string[],
  budget: Budget,
): Promise<{ written: SessionRef[]; waiting: number; failure: string | null }> {
  const written: SessionRef[] = [];
  let failure: string | null = null;
  let waiting = 0;
  for (const project of projects) {
    const owed = (await listProjectDigests(remote, project))
      .filter((s) => s.summary_to_follow)
      .sort((a, b) => (b.last_activity_at ?? '').localeCompare(a.last_activity_at ?? ''));
    for (const entry of owed) {
      if (!budgetOpen(budget)) {
        waiting++;
        continue;
      }
      const ref = { source: entry.source, id: entry.id };
      try {
        const session = await getSession(remote, ref);
        if (session.messages.length > 0) spend(budget);
        const digest = await summarize(llm, session);
        // 'moved' means the session changed since; its own upload brings a fresh summary.
        if ((await putDigest(remote, ref, session.content_hash, digest)) === 'saved' && 'body' in digest) written.push({ project, session: `${entry.source}:${entry.id}` });
      } catch (e) {
        const stop = stopReason(e);
        if (stop !== null) budget.stopped = stop;
        else failure = `summary failed: ${(e as Error).message}`;
        waiting++;
      }
    }
  }
  return { written, waiting, failure };
}
