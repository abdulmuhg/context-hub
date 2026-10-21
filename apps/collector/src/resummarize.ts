import type { Llm } from '@context-hub/core';
import { SUMMARY_CAP, loadConfig, loadToken } from './config.js';
import { projectMatches } from './project.js';
import { budgetOpen, MAX_CHARS, newBudget, spend, stopReason, summarize, updatePages, type SessionRef } from './summaries.js';
import { buildLlm } from './sync.js';
import { getSession, listProjectDigests, putDigest, type ProjectDigestEntry, type Remote } from './upload.js';

export interface ResummarizeOptions {
  hubDir: string;
  /** Narrows to one tracked project, by key or short name. */
  project?: string;
  /** Lifts the cap on summaries written in this run. */
  all?: boolean;
  /** Also rewrites computer-written digests whose model is not this one. */
  modelNot?: string;
  /** Writes the summaries. Left out, Claude Code on this computer is used; null means it is not installed. */
  llm?: Llm | null;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface ResummarizeReport {
  rewritten: SessionRef[];
  waiting: { count: number; reason: string | null };
  pages: { updated: string[]; left: string[] };
}

/**
 * A summary is rewritten when the hub's own model wrote it (today's Haiku
 * summaries and the fallback's), when it is missing, failed or refused, or when
 * the caller asks for every model but one. A note is its own summary.
 */
function qualifies(e: ProjectDigestEntry, modelNot: string | undefined): boolean {
  if (e.model === 'note') return false;
  if (e.written_by === null) return true;
  if (e.status !== 'ok') return true;
  return modelNot !== undefined && e.model !== modelNot;
}

/**
 * Rewrites older summaries with the model set on this computer. It works from
 * the transcripts stored on the hub, because Claude Code deletes local ones after
 * 30 days. Each project whose summaries changed gets a full page rebuild.
 */
export async function runResummarize(opts: ResummarizeOptions): Promise<ResummarizeReport> {
  const cfg = loadConfig(opts.hubDir);
  const token = loadToken(opts.hubDir);
  if (!cfg.server_url || !token) throw new Error('No server address or upload token. Run `hub init` first.');
  const remote: Remote = { url: cfg.server_url, token, fetchImpl: opts.fetchImpl };

  const projects = cfg.tracked.filter((key) => !opts.project || projectMatches(opts.project, key));
  if (opts.project && projects.length === 0) throw new Error(`"${opts.project}" is not tracked. Run \`hub track ${opts.project}\` first.`);

  const llm = opts.llm !== undefined ? opts.llm : buildLlm(cfg);
  if (llm === null) throw new Error('Claude Code is not installed, so sessions wait here. Install it, then run: claude');

  const todo: { project: string; entry: ProjectDigestEntry }[] = [];
  for (const project of projects) {
    for (const entry of await listProjectDigests(remote, project)) if (qualifies(entry, opts.modelNot)) todo.push({ project, entry });
  }
  todo.sort((a, b) => (b.entry.last_activity_at ?? '').localeCompare(a.entry.last_activity_at ?? ''));

  const budget = newBudget(opts.all);
  const rewritten: SessionRef[] = [];
  const touched = new Set<string>();
  let waiting = 0;
  let capHit = false;
  let failure: string | null = null;

  for (const { project, entry } of todo) {
    if (!budgetOpen(budget)) {
      if (budget.stopped === null) capHit = true;
      waiting++;
      continue;
    }
    const ref = { source: entry.source, id: entry.id };
    try {
      const session = await getSession(remote, ref);
      if (session.messages.length > 0) spend(budget);
      const digest = await summarize(llm, session);
      // 'moved' means the session changed since it was listed: its own sync brings a fresh summary.
      if ((await putDigest(remote, ref, session.content_hash, digest)) === 'saved') {
        rewritten.push({ project, session: `${entry.source}:${entry.id}` });
        touched.add(project);
      } else waiting++;
    } catch (e) {
      const stop = stopReason(e);
      if (stop !== null) budget.stopped = stop;
      else failure = `summary failed: ${(e as Error).message}`;
      waiting++;
    }
  }

  const now = (opts.now ?? (() => new Date()))();
  const pages = await updatePages(remote, llm, [...touched], budget, { now: now.toISOString(), maxChars: MAX_CHARS, forceRebuild: true });

  return {
    rewritten,
    waiting: {
      count: waiting,
      reason: waiting === 0 ? null : (budget.stopped ?? (capHit ? `cap of ${SUMMARY_CAP} reached. Run hub resummarize --all to catch up` : failure)),
    },
    pages,
  };
}
