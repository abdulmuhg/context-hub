import type { Message } from '@context-hub/core';
import type { Db } from './db.js';
import {
  clearStateRetry,
  deleteProjectState,
  failDigest,
  failState,
  getProjectState,
  markStateDirty,
  nextDueDigest,
  nextProjectNeedingState,
  okDigestsForProject,
  refuseDigest,
  saveDigest,
  saveProjectState,
  stateIsWaiting,
  type DigestBody,
  type DueDigest,
} from './digest-store.js';
import { LlmRefusal, type Llm } from './llm.js';
import { renderDigest, renderLines, splitParts } from './transcript.js';

export const CHARS_PER_TOKEN = 3;
export const DEFAULT_MAX_INPUT_TOKENS = 80000;
export const REBUILD_AFTER_MS = 7 * 24 * 60 * 60_000;

export interface WorkerDeps {
  db: Db;
  llm: Llm;
  now?: () => Date;
  maxInputTokens?: number;
  log?: (line: string) => void;
}

interface Ctx {
  db: Db;
  llm: Llm;
  now: () => string;
  maxChars: number;
  log: (line: string) => void;
}

function context(deps: WorkerDeps): Ctx {
  const now = deps.now ?? (() => new Date());
  return {
    db: deps.db,
    llm: deps.llm,
    now: () => now().toISOString(),
    maxChars: (deps.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS) * CHARS_PER_TOKEN,
    log: deps.log ?? ((line) => console.log(line)),
  };
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function loadMessages(db: Db, sessionRowId: number): Message[] {
  const rows = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY seq').all(sessionRowId) as {
    seq: number;
    role: 'user' | 'assistant';
    kind: 'text' | 'tool_call';
    ts: string | null;
    text: string | null;
    tool_name: string | null;
    tool_input: string | null;
    tool_result: string | null;
    tool_status: 'ok' | 'error' | null;
  }[];
  return rows.map((r) =>
    r.kind === 'text'
      ? { seq: r.seq, role: r.role, kind: 'text', ts: r.ts, text: r.text ?? '' }
      : {
          seq: r.seq,
          role: 'assistant',
          kind: 'tool_call',
          ts: r.ts,
          tool_name: r.tool_name ?? '',
          tool_input: r.tool_input ?? '',
          tool_result: r.tool_result ?? '',
          tool_status: r.tool_status ?? 'ok',
        },
  );
}

async function writeDigest(c: Ctx, due: DueDigest): Promise<DigestBody> {
  const parts = splitParts(renderLines(loadMessages(c.db, due.session_id)), c.maxChars);
  if (parts.length === 0) {
    return { goal: 'Empty session: no conversation content.', done: [], decisions: [], open_items: [], key_refs: [] };
  }
  if (parts.length === 1) {
    return c.llm.digest({ project: due.project_key, title: due.title, transcript: parts[0]!, part: null });
  }
  const bodies: DigestBody[] = [];
  for (let i = 0; i < parts.length; i++) {
    bodies.push(await c.llm.digest({ project: due.project_key, title: due.title, transcript: parts[i]!, part: { index: i + 1, total: parts.length } }));
  }
  return c.llm.mergeDigests({ project: due.project_key, title: due.title, parts: bodies });
}

/** The sessions a page is built from. A change during a model call means the page is already out of date. */
const pageSources = (db: Db, projectId: number): string =>
  okDigestsForProject(db, projectId)
    .map((d) => d.session_id)
    .join('|');

/** Saves a page, and keeps it flagged when its sources changed while the model was working. */
function savePage(c: Ctx, projectId: number, page: { summary: string; body: string }, fullRebuild: boolean, sourcesBefore: string): void {
  saveProjectState(c.db, projectId, { ...page, model: c.llm.model }, c.now(), fullRebuild);
  clearStateRetry(c.db, projectId);
  if (pageSources(c.db, projectId) !== sourcesBefore) markStateDirty(c.db, projectId);
}

/** Rebuilds a project's page from its ok digests, or removes the page when none are left. */
async function rebuildState(c: Ctx, projectId: number): Promise<void> {
  const project = c.db.prepare('SELECT key FROM projects WHERE id = ?').get(projectId) as { key: string } | undefined;
  if (!project) return;
  const all = okDigestsForProject(c.db, projectId);
  if (all.length === 0) {
    deleteProjectState(c.db, projectId);
    clearStateRetry(c.db, projectId);
    return;
  }
  // Newest first until the limit is reached, then back into oldest-first order.
  const chosen: typeof all = [];
  let used = 0;
  for (let i = all.length - 1; i >= 0; i--) {
    const d = all[i]!;
    if (chosen.length > 0 && used + d.text.length > c.maxChars) break;
    chosen.unshift(d);
    used += d.text.length;
  }
  const truncated = chosen.length < all.length;
  const previous = truncated ? (getProjectState(c.db, projectId)?.body ?? null) : null;
  const sourcesBefore = pageSources(c.db, projectId);
  const page = await c.llm.projectState({
    project: project.key,
    mode: 'rebuild',
    previous,
    digests: chosen.map((d) => ({ session_id: d.session_id, title: d.title, date: d.last_activity_at, text: d.text })),
  });
  savePage(c, projectId, page, true, sourcesBefore);
}

async function updateStateAfterDigest(c: Ctx, due: DueDigest, text: string): Promise<void> {
  // The page failed recently and is waiting. Do not spend a call per digest on it;
  // flag it so the state pass rebuilds it with every digest once the wait is over.
  if (stateIsWaiting(c.db, due.project_id, c.now())) {
    markStateDirty(c.db, due.project_id);
    return;
  }
  const state = getProjectState(c.db, due.project_id);
  const old = state ? Date.parse(c.now()) - Date.parse(state.rebuilt_at) > REBUILD_AFTER_MS : false;
  if (!state || state.dirty || old) return rebuildState(c, due.project_id);

  const session = c.db.prepare('SELECT last_activity_at FROM sessions WHERE id = ?').get(due.session_id) as { last_activity_at: string | null } | undefined;
  const sourcesBefore = pageSources(c.db, due.project_id);
  const page = await c.llm.projectState({
    project: due.project_key,
    mode: 'merge',
    previous: state.body,
    digests: [{ session_id: `${due.source}:${due.source_session_id}`, title: due.title, date: session?.last_activity_at ?? null, text }],
  });
  savePage(c, due.project_id, page, false, sourcesBefore);
}

async function digestOne(c: Ctx, due: DueDigest): Promise<'digest' | 'error'> {
  const id = `${due.source}:${due.source_session_id}`;
  let body: DigestBody;
  try {
    body = await writeDigest(c, due);
  } catch (e) {
    if (e instanceof LlmRefusal) {
      refuseDigest(c.db, due.session_id, e.category, c.now());
      c.log(`digest ${id}: refused by the model (${e.category}); it will not be retried until the session changes`);
    } else {
      const r = failDigest(c.db, due.session_id, message(e), c.now());
      c.log(`digest ${id}: failed (${message(e)}); attempt ${r.attempts}, next try ${r.next_attempt_at}`);
    }
    return 'error';
  }

  const text = renderDigest(body);
  const saved = saveDigest(c.db, { sessionRowId: due.session_id, hash: due.content_hash, model: c.llm.model, body, text, now: c.now() });
  if (!saved) {
    c.log(`digest ${id}: the session changed while its digest was being written; it stays queued`);
    return 'digest';
  }

  try {
    await updateStateAfterDigest(c, due, text);
  } catch (e) {
    // The digest is safe. Leave the page to the state pass.
    markStateDirty(c.db, due.project_id);
    const r = failState(c.db, due.project_id, message(e), c.now());
    c.log(`state ${due.project_key}: update failed (${message(e)}); attempt ${r.attempts}, next try ${r.next_attempt_at}`);
    return 'error';
  }
  return 'digest';
}

/** Does at most one job. */
export async function runOnce(deps: WorkerDeps): Promise<'digest' | 'state' | 'idle' | 'error'> {
  const c = context(deps);
  const due = nextDueDigest(c.db, c.now());
  if (due) return digestOne(c, due);

  const projectId = nextProjectNeedingState(c.db, c.now());
  if (projectId !== null) {
    try {
      await rebuildState(c, projectId);
      return 'state';
    } catch (e) {
      const r = failState(c.db, projectId, message(e), c.now());
      c.log(`state project ${projectId}: rebuild failed (${message(e)}); attempt ${r.attempts}, next try ${r.next_attempt_at}`);
      return 'error';
    }
  }
  return 'idle';
}

/** Runs jobs until stopped, resting after an idle or failed pass. */
export function startWorker(deps: WorkerDeps, idleMs = 5000): { stop: () => Promise<void> } {
  const log = deps.log ?? ((line: string) => console.log(line));
  let stopped = false;
  let wake: (() => void) | null = null;

  const rest = (): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, idleMs);
      timer.unref();
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  const loop = (async () => {
    while (!stopped) {
      let result: Awaited<ReturnType<typeof runOnce>>;
      try {
        result = await runOnce(deps);
      } catch (e) {
        log(`worker: unexpected error (${message(e)})`);
        result = 'error';
      }
      if (!stopped && (result === 'idle' || result === 'error')) await rest();
    }
  })();

  return {
    stop: async () => {
      stopped = true;
      wake?.();
      await loop;
    },
  };
}
