import { existsSync } from 'node:fs';
import { sanitizeSession, type PersonalConfig } from '@context-hub/core';
import { ALL_ADAPTERS, type Adapter, type RawSession, type SessionFile } from './adapters/index.js';
import {
  loadConfig,
  loadPersonal,
  loadState,
  loadToken,
  saveState,
  settingsFingerprint,
  type Config,
  type State,
} from './config.js';
import { applyOverrides, projectMatches, realGit, resolveProjectKey, type GitRunner } from './project.js';
import { putSession, reportSyncRun, type Remote } from './upload.js';

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
}

export interface SessionRef {
  project: string;
  session: string;
}

export interface SyncReport {
  uploaded: SessionRef[];
  wouldUpload: SessionRef[];
  unchanged: number;
  secrets: Record<string, number>;
  personal: { session: string; type: string; count: number }[];
  warnings: { session: string; bad_lines: number; unknown_records: number; dropped_blocks: number }[];
  errors: string[];
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
  files.sort((a, b) => Number(a.parent !== null) - Number(b.parent !== null)); // main sessions first

  const bySource = new Map(adapters.map((a) => [a.source, a]));
  const read = (file: SessionFile): RawSession => bySource.get(file.source)!.read(file);
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
    personal: { card: cfg.personal.card, list: cfg.personal.list, entries },
    items,
    errors,
    read,
  };
}

function isSelected(item: Scanned, cfg: Config, opts: SyncOptions): boolean {
  if (opts.session) {
    const wanted = opts.session;
    const matches = (key: string | null) => key !== null && (key === wanted || key.slice(key.indexOf(':') + 1) === wanted);
    return matches(item.sessionKey) || matches(item.parentKey);
  }
  if (cfg.skipped.includes(item.sessionKey)) return false;
  if (item.parentKey && cfg.skipped.includes(item.parentKey)) return false;
  if (opts.project) return cfg.tracked.includes(item.projectKey) && projectMatches(opts.project, item.projectKey);
  return cfg.tracked.includes(item.projectKey);
}

export async function runSync(opts: SyncOptions): Promise<SyncReport> {
  const s = scan(opts);
  const report: SyncReport = {
    uploaded: [],
    wouldUpload: [],
    unchanged: 0,
    secrets: {},
    personal: [],
    warnings: [],
    errors: [...s.errors],
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

  let stopped = false; // set after the first failed upload

  for (const item of s.items) {
    const { file, sessionKey, projectKey } = item;
    const prev = s.state.files[file.path];
    const remember = (hash: string | null, syncedAt: string | null): void => {
      if (dryRun) return;
      s.state.files[file.path] = { size: file.size, mtimeMs: file.mtimeMs, project_key: projectKey, hash, synced_at: syncedAt };
    };

    if (!isSelected(item, s.cfg, opts)) {
      if (prev) {
        if (!dryRun) prev.project_key = projectKey; // keep size, mtime and hash paired; only the cached key may move
      } else remember(null, null);
      continue;
    }
    if (prev && item.same && prev.hash !== null) {
      report.unchanged++;
      continue;
    }
    if (stopped) continue;

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
      remember(prev.hash, prev.synced_at);
      continue;
    }

    const ref: SessionRef = { project: projectKey, session: sessionKey };
    if (dryRun) {
      report.wouldUpload.push(ref);
    } else {
      try {
        await putSession(remote!, result.session);
      } catch (e) {
        report.errors.push((e as Error).message);
        stopped = true;
        continue;
      }
      report.uploaded.push(ref);
      remember(result.session.content_hash, now().toISOString());
    }

    for (const [type, n] of Object.entries(result.secrets)) report.secrets[type] = (report.secrets[type] ?? 0) + n;
    for (const [type, count] of Object.entries(result.personal)) report.personal.push({ session: sessionKey, type, count });
    const w = raw.warnings;
    if (w.bad_lines + w.unknown_records + w.dropped_blocks > 0) report.warnings.push({ session: sessionKey, ...w });
  }

  if (!dryRun) {
    // Keep forcing a full pass until one finishes cleanly.
    if (!opts.project && !opts.session && report.errors.length === 0) s.state.fingerprint = s.fingerprint;
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
