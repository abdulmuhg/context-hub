import { existsSync } from 'node:fs';
import { sep } from 'node:path';
import { sanitizeSession, type HashedSession, type Llm, type PersonalConfig, type UploadDigest } from '@context-hub/core';
import { ALL_ADAPTERS, type Adapter, type RawSession, type SessionFile } from './adapters/index.js';
import { ClaudeCodeLlm, findClaude } from './claude-llm.js';
import {
  DEFAULT_SUMMARY_EFFORT,
  DEFAULT_SUMMARY_MODEL,
  SUMMARY_CAP,
  loadConfig,
  loadPersonal,
  loadState,
  loadToken,
  saveState,
  settingsFingerprint,
  type Config,
  type State,
  type StateEntry,
} from './config.js';
import { discoverDocs, docId, readDoc } from './docs.js';
import { applyOverrides, projectMatches, realGit, resolveProjectKey, type GitRunner } from './project.js';
import { budgetOpen, catchUpOwed, MAX_CHARS, newBudget, spend, stopReason, summarize, updatePages, type SessionRef } from './summaries.js';
import { deleteRemote, getStatus, putSession, reportSyncRun, type HubStatus, type Remote } from './upload.js';

export type { SessionRef };

export interface SyncOptions {
  /** The user's home folder, where the tools keep their history. */
  home: string;
  /** Where the collector keeps its own files. */
  hubDir: string;
  dryRun?: boolean;
  project?: string;
  /** A session id, with or without the "<source>:" prefix. */
  session?: string;
  adapters?: Adapter[];
  git?: GitRunner;
  exists?: (path: string) => boolean;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /**
   * Writes the summaries. Left out, Claude Code on this computer is used; null means it is not installed.
   * Tests pass a fake.
   */
  llm?: Llm | null;
  /** Lifts the cap on summaries written in this run. */
  all?: boolean;
  /** Called before each session or document that has to be read and possibly uploaded. */
  onProgress?: (p: { done: number; total: number; project: string }) => void;
}

export interface SyncReport {
  uploaded: SessionRef[];
  wouldUpload: SessionRef[];
  /** Sessions whose summary was written in this run. */
  summarized: SessionRef[];
  /** What a dry run would summarize. No model is called. */
  wouldSummarize: SessionRef[];
  /** Documents whose file is gone, removed from the server. */
  deleted: SessionRef[];
  wouldDelete: SessionRef[];
  unchanged: number;
  secrets: Record<string, number>;
  personal: { session: string; type: string; count: number }[];
  warnings: { session: string; bad_lines: number; unknown_records: number; dropped_blocks: number }[];
  errors: string[];
  /** Sessions that did not go up because their summary could not be written, and why. */
  waiting: { count: number; reason: string | null };
  /** State pages written in this run, and those left for a later sync. */
  pages: { updated: string[]; left: string[] };
  /** Set when the run finished but the server could not be told about it. */
  reportError?: string;
}

interface Scanned {
  file: SessionFile;
  sessionKey: string;
  parentKey: string | null;
  projectKey: string;
  /** True when size and mtime match the state entry and settings are unchanged. */
  same: boolean;
  /** Present only when the file had to be parsed to learn its project. */
  raw: RawSession | null;
}

interface Scan {
  cfg: Config;
  state: State;
  fingerprint: string;
  /** The cleaning settings changed since the last complete sync, so every session is cleaned again. */
  recleaning: boolean;
  personal: PersonalConfig;
  items: Scanned[];
  errors: string[];
  read: (file: SessionFile) => RawSession;
}

/** Discovers every session file and works out its project key, parsing as little as possible. */
function scan(opts: Pick<SyncOptions, 'home' | 'hubDir' | 'adapters' | 'git' | 'exists'>): Scan {
  const cfg = loadConfig(opts.hubDir);
  const entries = loadPersonal(opts.hubDir);
  const state = loadState(opts.hubDir);
  const fingerprint = settingsFingerprint(cfg, entries);
  const force = state.fingerprint !== fingerprint;
  const adapters = opts.adapters ?? ALL_ADAPTERS;
  const deps = { git: opts.git ?? realGit, exists: opts.exists ?? existsSync };
  const errors: string[] = [];

  const files: SessionFile[] = [];
  for (const adapter of adapters) {
    try {
      files.push(...adapter.discover(opts.home));
    } catch (e) {
      errors.push(`${adapter.source}: ${(e as Error).message}`);
    }
  }
  files.push(...discoverDocs(cfg.docs, errors));
  files.sort((a, b) => Number(a.parent !== null) - Number(b.parent !== null)); // main sessions first

  const bySource = new Map(adapters.map((a) => [a.source, a]));
  const read = (file: SessionFile): RawSession => (file.source === 'doc' ? readDoc(file) : bySource.get(file.source)!.read(file));
  const keyOf = new Map<string, string>();
  const items: Scanned[] = [];

  for (const file of files) {
    const sessionKey = `${file.source}:${file.id}`;
    const parentKey = file.parent ? `${file.source}:${file.parent}` : null;
    const prev = state.files[file.path];
    const same = !force && !!prev && prev.size === file.size && prev.mtimeMs === file.mtimeMs;

    let raw: RawSession | null = null;
    let projectKey: string;
    try {
      if (parentKey && keyOf.has(parentKey)) {
        projectKey = keyOf.get(parentKey)!;
      } else if (file.project_key !== undefined) {
        projectKey = applyOverrides(file.project_key, sessionKey, cfg);
      } else if (same) {
        projectKey = prev.project_key;
      } else {
        raw = read(file);
        const resolved = resolveProjectKey(
          { cwd: raw.cwd, cwds: raw.cwds, remoteHint: raw.remote_hint, pathHints: raw.path_hints },
          deps,
        );
        projectKey = applyOverrides(resolved, sessionKey, cfg);
      }
    } catch (e) {
      errors.push(`${sessionKey}: ${(e as Error).message}`);
      continue;
    }
    keyOf.set(sessionKey, projectKey);
    items.push({ file, sessionKey, parentKey, projectKey, same, raw });
  }

  return {
    cfg,
    state,
    fingerprint,
    recleaning: force,
    personal: { card: cfg.personal.card, list: cfg.personal.list, entries },
    items,
    errors,
    read,
  };
}

/** Whether this run uploads the project's sessions and documents. */
function projectSelected(projectKey: string, cfg: Config, opts: SyncOptions): boolean {
  if (opts.project) return cfg.tracked.includes(projectKey) && projectMatches(opts.project, projectKey);
  return cfg.tracked.includes(projectKey);
}

/** Uploaded documents whose file is gone from a folder that is still there. */
function vanishedDocs(s: Scan, opts: SyncOptions): { path: string; ref: SessionRef }[] {
  if (opts.session) return [];
  const present = new Set(s.items.map((i) => i.file.path));
  const out: { path: string; ref: SessionRef }[] = [];
  for (const [path, entry] of Object.entries(s.state.files)) {
    if (entry.hash === null || present.has(path)) continue;
    const folder = s.cfg.docs.find((f) => path.startsWith(f.path + sep));
    if (!folder || !existsSync(folder.path)) continue;
    const project = applyOverrides(folder.project, `doc:${docId(folder, path)}`, s.cfg);
    if (!projectSelected(project, s.cfg, opts)) continue;
    out.push({ path, ref: { project, session: `doc:${docId(folder, path)}` } });
  }
  return out;
}

function isSelected(item: Scanned, cfg: Config, opts: SyncOptions): boolean {
  if (opts.session) {
    const wanted = opts.session;
    const matches = (key: string | null) => key !== null && (key === wanted || key.slice(key.indexOf(':') + 1) === wanted);
    return matches(item.sessionKey) || matches(item.parentKey);
  }
  if (cfg.skipped.includes(item.sessionKey)) return false;
  if (item.parentKey && cfg.skipped.includes(item.parentKey)) return false;
  return projectSelected(item.projectKey, cfg, opts);
}

/** A changed session or document, read and cleaned, waiting to be uploaded. */
interface Work {
  item: Scanned;
  raw: RawSession;
  session: HashedSession;
  ref: SessionRef;
  prev: StateEntry | undefined;
  secrets: Record<string, number>;
  personal: Record<string, number>;
}

/** Builds the Claude Code writer from this computer's settings, or null when `claude` is not installed. */
export function buildLlm(cfg: Config): Llm | null {
  const cmd = findClaude();
  if (cmd === null) return null;
  return new ClaudeCodeLlm({ model: cfg.summaries?.model ?? DEFAULT_SUMMARY_MODEL, effort: cfg.summaries?.effort ?? DEFAULT_SUMMARY_EFFORT, cmd });
}

export async function runSync(opts: SyncOptions): Promise<SyncReport> {
  const s = scan(opts);
  const report: SyncReport = {
    uploaded: [],
    wouldUpload: [],
    summarized: [],
    wouldSummarize: [],
    deleted: [],
    wouldDelete: [],
    unchanged: 0,
    secrets: {},
    personal: [],
    warnings: [],
    errors: [...s.errors],
    waiting: { count: 0, reason: null },
    pages: { updated: [], left: [] },
  };
  const dryRun = opts.dryRun === true;
  const now = opts.now ?? (() => new Date());

  const token = loadToken(opts.hubDir);
  let remote: Remote | null = null;
  if (!dryRun) {
    if (!s.cfg.server_url || !token) {
      report.errors.push('No server address or upload token. Run `hub init` first.');
      return report;
    }
    remote = { url: s.cfg.server_url, token, fetchImpl: opts.fetchImpl };
  }
  const llm: Llm | null = dryRun ? null : opts.llm !== undefined ? opts.llm : buildLlm(s.cfg);
  const budget = newBudget(opts.all);

  let stopped = false; // set after the first failed upload
  const total = s.items.filter((i) => isSelected(i, s.cfg, opts) && !(s.state.files[i.file.path]?.hash != null && i.same)).length;
  let done = 0;

  const remember = (w: Pick<Work, 'item'>, hash: string | null, syncedAt: string | null): void => {
    if (dryRun) return;
    const { file, projectKey } = w.item;
    s.state.files[file.path] = { size: file.size, mtimeMs: file.mtimeMs, project_key: projectKey, hash, synced_at: syncedAt };
  };

  // Read and clean everything that changed. Nothing is uploaded yet: a main session goes up with its summary.
  const works: Work[] = [];
  for (const item of s.items) {
    const { file, sessionKey, projectKey } = item;
    const prev = s.state.files[file.path];

    if (!isSelected(item, s.cfg, opts)) {
      if (prev) {
        if (!dryRun) prev.project_key = projectKey; // keep size, mtime and hash paired; only the cached key may move
      } else remember({ item }, null, null);
      continue;
    }
    if (prev && item.same && prev.hash !== null) {
      report.unchanged++;
      continue;
    }
    opts.onProgress?.({ done: ++done, total, project: projectKey });

    let raw: RawSession;
    try {
      raw = item.raw ?? s.read(file);
    } catch (e) {
      report.errors.push(`${sessionKey}: ${(e as Error).message}`);
      continue;
    }

    const result = sanitizeSession(
      {
        source: raw.source,
        source_session_id: raw.source_session_id,
        account_id: raw.account_id,
        project_key: projectKey,
        parent: raw.parent,
        title: raw.title,
        cwd: raw.cwd,
        git_branch: raw.git_branch,
        messages: raw.messages,
      },
      s.personal,
    );

    if (prev?.hash === result.session.content_hash) {
      report.unchanged++;
      remember({ item }, prev.hash, prev.synced_at);
      continue;
    }
    works.push({ item, raw, session: result.session, ref: { project: projectKey, session: sessionKey }, prev, secrets: result.secrets, personal: result.personal });
  }

  /** Adds what cleaning found in a session to the report, once the session is uploaded (or listed in a dry run). */
  const recordFindings = (w: Work): void => {
    for (const [type, n] of Object.entries(w.secrets)) report.secrets[type] = (report.secrets[type] ?? 0) + n;
    for (const [type, count] of Object.entries(w.personal)) report.personal.push({ session: w.ref.session, type, count });
    const warn = w.raw.warnings;
    if (warn.bad_lines + warn.unknown_records + warn.dropped_blocks > 0) report.warnings.push({ session: w.ref.session, ...warn });
  };

  /** Uploads one session, with its summary if it has one. False when the upload failed, after which nothing more is sent. */
  const upload = async (w: Work, digest?: UploadDigest): Promise<boolean> => {
    if (dryRun) {
      report.wouldUpload.push(w.ref);
      recordFindings(w);
      return true;
    }
    try {
      await putSession(remote!, w.session, digest);
    } catch (e) {
      report.errors.push((e as Error).message);
      stopped = true;
      return false;
    }
    report.uploaded.push(w.ref);
    if (digest && 'body' in digest) report.summarized.push(w.ref);
    remember(w, w.session.content_hash, now().toISOString());
    recordFindings(w);
    return true;
  };

  const isDoc = (w: Work): boolean => w.item.file.source === 'doc';
  const isMain = (w: Work): boolean => w.item.file.parent === null && !isDoc(w);

  // Documents have no summary: they go up as they are.
  for (const w of works.filter(isDoc)) {
    if (stopped) break;
    await upload(w);
  }

  // The cleaning settings changed: every session already on the hub goes up again at once, so the old
  // text (which may hold what was just removed) is replaced. Its summary is written on a later sync.
  const recleaned = new Set<Work>();
  if (s.recleaning) {
    for (const w of works) {
      if (isDoc(w) || w.prev?.hash == null) continue;
      recleaned.add(w);
      if (stopped) continue;
      await upload(w, isMain(w) ? { summary_to_follow: true } : undefined);
    }
  }
  const fresh = works.filter((w) => !isDoc(w) && !recleaned.has(w));

  // Ask the hub what it needs from this computer.
  let status: HubStatus | null = null;
  if (!dryRun && !stopped) {
    try {
      status = await getStatus(remote!);
    } catch {
      status = null;
    }
  }

  let failure: string | null = null;
  /** Projects whose page waits for summaries still owed after a re-clean, so it is not rebuilt without them. */
  const deferred = new Set<string>(works.filter((w) => recleaned.has(w) && isMain(w)).map((w) => w.ref.project));
  let capHit = false;
  let notInstalled = false;
  let waiting = 0;

  // Summaries owed after an earlier re-clean come first.
  if (llm && status && (status.summaries_owed ?? 0) > 0 && !opts.session && !stopped) {
    const projects = s.cfg.tracked.filter((key) => !opts.project || projectMatches(opts.project, key));
    try {
      const owed = await catchUpOwed(remote!, llm, projects, budget);
      report.summarized.push(...owed.written);
      waiting += owed.waiting;
      failure = owed.failure ?? failure;
      for (const key of owed.stillOwed) deferred.add(key);
    } catch (e) {
      report.errors.push((e as Error).message);
      stopped = true;
    }
  }

  // New and changed main sessions, newest first, each with its summary.
  const mains = fresh.filter(isMain).sort((a, b) => (b.session.last_activity_at ?? '').localeCompare(a.session.last_activity_at ?? ''));
  const subsOf = (w: Work): Work[] => fresh.filter((x) => x.item.parentKey === w.item.sessionKey);
  const mainKeys = new Set(mains.map((w) => w.item.sessionKey));

  for (const w of mains) {
    if (stopped) break;
    const quiet = w.session.messages.length === 0; // an empty session is summarized without a model call
    let digest: UploadDigest | undefined;

    if (dryRun) {
      if (quiet || budgetOpen(budget)) {
        if (!quiet) spend(budget);
        report.wouldSummarize.push(w.ref);
      } else {
        capHit = true;
        waiting++;
      }
      await upload(w);
      for (const sub of subsOf(w)) await upload(sub);
      continue;
    }

    if (llm === null) {
      if (status?.server_summaries !== true) {
        notInstalled = true;
        waiting++;
        continue;
      }
      // The hub writes this one with its own key.
    } else {
      if (!quiet && !budgetOpen(budget)) {
        if (budget.stopped === null) capHit = true;
        waiting++;
        continue;
      }
      if (!quiet) spend(budget);
      try {
        digest = await summarize(llm, w.session);
      } catch (e) {
        const stop = stopReason(e);
        if (stop !== null) {
          budget.stopped = stop;
          waiting++;
          continue;
        }
        const message = (e as Error).message;
        const hash = w.session.content_hash;
        const count = (w.prev?.digest_failures?.hash === hash ? w.prev.digest_failures.count : 0) + 1;
        if (count >= 3) {
          digest = { failed: message };
        } else {
          const { file, projectKey } = w.item;
          const entry = w.prev ?? { size: file.size, mtimeMs: file.mtimeMs, project_key: projectKey, hash: null, synced_at: null };
          s.state.files[file.path] = { ...entry, digest_failures: { hash, count } };
          failure = `summary failed: ${message}`;
          waiting++;
          continue;
        }
      }
    }

    if (!(await upload(w, digest))) break;
    for (const sub of subsOf(w)) if (!(await upload(sub))) break;
  }

  // A subagent whose parent is already on the hub and unchanged goes up at once.
  for (const w of fresh.filter((x) => !isMain(x))) {
    if (stopped) break;
    if (w.item.parentKey !== null && mainKeys.has(w.item.parentKey)) continue;
    await upload(w);
  }

  // State pages come last, once this run's summaries are on the hub.
  if (llm && remote && !stopped && !opts.session) {
    const selected = s.cfg.tracked.filter((key) => !opts.project || projectMatches(opts.project, key));
    let needed: string[] = [];
    try {
      needed = ((await getStatus(remote)).pages_needed ?? []).filter((key) => selected.includes(key));
    } catch {
      needed = [];
    }
    report.pages.left.push(...needed.filter((key) => deferred.has(key)));
    const pages = await updatePages(remote, llm, needed.filter((key) => !deferred.has(key)), budget, { now: now().toISOString(), maxChars: MAX_CHARS });
    report.pages.updated.push(...pages.updated);
    report.pages.left.push(...pages.left);
  }

  report.waiting = {
    count: waiting,
    reason:
      waiting === 0
        ? null
        : (budget.stopped ?? (notInstalled ? 'Claude Code is not installed' : capHit ? `cap of ${SUMMARY_CAP} reached. Run hub sync --all to catch up` : failure)),
  };

  for (const gone of vanishedDocs(s, opts)) {
    if (dryRun) {
      report.wouldDelete.push(gone.ref);
      continue;
    }
    if (stopped) break;
    try {
      await deleteRemote(remote!, { source: 'doc', id: gone.ref.session.slice('doc:'.length) });
    } catch (e) {
      report.errors.push((e as Error).message);
      stopped = true;
      continue;
    }
    delete s.state.files[gone.path];
    report.deleted.push(gone.ref);
  }

  if (!dryRun) {
    // Keep forcing a full pass until one finishes cleanly.
    if (!opts.project && !opts.session && report.errors.length === 0) s.state.fingerprint = s.fingerprint;
    if (report.waiting.count > 0) s.state.last_waiting = { ...report.waiting, at: now().toISOString() };
    else delete s.state.last_waiting;
    saveState(opts.hubDir, s.state);
    try {
      await reportSyncRun(remote!, {
        finished_at: now().toISOString(),
        uploaded: report.uploaded.length,
        unchanged: report.unchanged,
        errors: report.errors.length,
      });
    } catch (e) {
      report.reportError = (e as Error).message;
    }
  }
  return report;
}

export interface ProjectRow {
  key: string;
  /** Main sessions per tool. */
  sessions: Record<string, number>;
  last_activity: string;
  tracked: boolean;
  last_synced: string | null;
}

export function listProjects(opts: Pick<SyncOptions, 'home' | 'hubDir' | 'adapters' | 'git' | 'exists'>): ProjectRow[] {
  const s = scan(opts);
  const rows = new Map<string, ProjectRow>();
  for (const item of s.items) {
    if (item.file.parent !== null) continue;
    const row =
      rows.get(item.projectKey) ??
      ({ key: item.projectKey, sessions: {}, last_activity: '', tracked: s.cfg.tracked.includes(item.projectKey), last_synced: null } as ProjectRow);
    row.sessions[item.file.source] = (row.sessions[item.file.source] ?? 0) + 1;
    const activity = new Date(item.file.mtimeMs).toISOString();
    if (activity > row.last_activity) row.last_activity = activity;
    const synced = s.state.files[item.file.path]?.synced_at ?? null;
    if (synced && (!row.last_synced || synced > row.last_synced)) row.last_synced = synced;
    rows.set(item.projectKey, row);
  }
  return [...rows.values()];
}
