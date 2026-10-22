import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Fail } from './errors.js';
import { runSync, type SyncOptions } from './sync.js';

const HOOK_SUFFIX = ' sync --auto';
const LOCK_MAX_AGE_MS = 10 * 60 * 1000;
const LOG_KEEP = 200;

type Json = Record<string, unknown>;

export function hookCommand(nodePath: string, bundlePath: string): string {
  return `"${nodePath}" "${bundlePath}"${HOOK_SUFFIX}`;
}

/**
 * True for a hook that runs our sync, wherever node and the bundle are: `"node" "…/hub.mjs" sync --auto`, or
 * `…/bin.js` for a hook written from a clone's build. Another tool's `sync --auto` hook is never ours.
 */
export function isOurHook(command: unknown): boolean {
  return typeof command === 'string' && /^"[^"\r\n]+" "[^"\r\n]*[\\/](?:hub\.mjs|bin\.js)" sync --auto$/.test(command);
}

function notJson(hint: string): Error {
  return new Fail(`~/.claude/settings.json is not valid JSON, so it was not changed.${hint}`);
}

/** Returns null when the file does not exist. Throws when it is not a JSON object. */
function readSettings(path: string, hint: string): Json | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw notJson(hint);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw notJson(hint);
  return parsed as Json;
}

function writeSettings(path: string, settings: Json, hadFile: boolean): void {
  mkdirSync(dirname(path), { recursive: true });
  if (hadFile) copyFileSync(path, `${path}.hub-backup`);
  const tmp = `${path}.hub-tmp`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  renameSync(tmp, path);
}

function sessionEnd(settings: Json, hint: string): unknown[] {
  const hooks = settings.hooks;
  if (hooks === undefined) return [];
  if (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)) throw notJson(hint);
  const list = (hooks as Json).SessionEnd;
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw notJson(hint);
  return list;
}

function commandsOf(entry: unknown): unknown[] {
  const hooks = (entry as Json | null)?.hooks;
  return Array.isArray(hooks) ? hooks.map((h) => (h as Json | null)?.command) : [];
}

/**
 * Goes through the SessionEnd entries and either rewrites our hooks to `command` (keeping the first, dropping
 * any more) or, with null, removes all of them. Other people's hooks are never touched.
 */
function rewriteOurs(list: unknown[], command: string | null): { list: unknown[]; found: number } {
  let found = 0;
  let placed = false;
  const next: unknown[] = [];
  for (const entry of list) {
    const inner = (entry as Json | null)?.hooks;
    if (!Array.isArray(inner)) {
      next.push(entry);
      continue;
    }
    const rest: unknown[] = [];
    for (const h of inner) {
      if (!isOurHook((h as Json | null)?.command)) {
        rest.push(h);
        continue;
      }
      found++;
      if (command !== null && !placed) {
        placed = true;
        rest.push({ ...(h as Json), command });
      }
    }
    if (rest.length === inner.length && rest.every((h, i) => h === inner[i])) next.push(entry);
    else if (rest.length > 0) next.push({ ...(entry as Json), hooks: rest });
  }
  return { list: next, found };
}

function store(settings: Json, settingsPath: string, list: unknown[]): void {
  const hooks = { ...((settings.hooks as Json | undefined) ?? {}) };
  if (list.length > 0) hooks.SessionEnd = list;
  else delete hooks.SessionEnd;
  if (Object.keys(hooks).length > 0) settings.hooks = hooks;
  else delete settings.hooks;
  writeSettings(settingsPath, settings, true);
}

/** Rewrites every hook of ours to run `command`, keeping only one. Writes nothing when nothing changes. */
export function repointHook(settingsPath: string, command: string): { repointed: number } {
  const hint = ` Fix it or add the hook by hand: ${command}`;
  const settings = readSettings(settingsPath, hint);
  if (!settings) return { repointed: 0 };
  const list = sessionEnd(settings, hint);
  const { list: next, found } = rewriteOurs(list, command);
  if (found === 0 || JSON.stringify(next) === JSON.stringify(list)) return { repointed: 0 };
  store(settings, settingsPath, next);
  return { repointed: found };
}

/** Turns auto sync on. A hook of ours already there (even one for another path) is repointed, never doubled. */
export function autoOn(settingsPath: string, command: string): { changed: boolean } {
  const hint = ` Fix it or add the hook by hand: ${command}`;
  const settings = readSettings(settingsPath, hint);
  const list = sessionEnd(settings ?? {}, hint);
  if (list.some((e) => commandsOf(e).some(isOurHook))) return { changed: repointHook(settingsPath, command).repointed > 0 };
  const next: Json = settings ?? {};
  const hooks = { ...((next.hooks as Json | undefined) ?? {}) };
  hooks.SessionEnd = [...list, { hooks: [{ type: 'command', command, timeout: 10 }] }];
  next.hooks = hooks;
  writeSettings(settingsPath, next, settings !== null);
  return { changed: true };
}

/** Turns auto sync off by removing every hook of ours: two would start two syncs. */
export function autoOff(settingsPath: string): { removed: number } {
  const settings = readSettings(settingsPath, '');
  if (!settings) return { removed: 0 };
  const { list, found } = rewriteOurs(sessionEnd(settings, ''), null);
  if (found === 0) return { removed: 0 };
  store(settings, settingsPath, list);
  return { removed: found };
}

function readLines(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split(/\r?\n/).filter((l) => l !== '');
}

export function autoStatus(settingsPath: string, logPath: string): { on: boolean; lastLine: string | null } {
  let on = false;
  try {
    const settings = readSettings(settingsPath, '');
    if (settings) on = sessionEnd(settings, '').some((e) => commandsOf(e).some(isOurHook));
  } catch {
    // an unreadable settings file means the hook is not (reliably) on
  }
  return { on, lastLine: readLines(logPath).at(-1) ?? null };
}

/** Takes the lock, or returns false when a younger one exists. A stale lock is taken over. */
export function takeLock(lockPath: string, now: Date): boolean {
  try {
    writeFileSync(lockPath, now.toISOString(), { flag: 'wx' });
    return true;
  } catch {
    // held, or left behind
  }
  try {
    const started = Date.parse(readFileSync(lockPath, 'utf8').trim());
    if (Number.isFinite(started) && now.getTime() - started < LOCK_MAX_AGE_MS) return false;
    writeFileSync(lockPath, now.toISOString());
    return true;
  } catch {
    return false;
  }
}

/**
 * Keeps the lock fresh while a sync works. Writing summaries can take longer
 * than the lock's 10 minutes, and a second auto-sync must not start meanwhile
 * and write the same ones. It only touches a lock that still exists. Returns the function that stops it.
 */
export function startLockHeartbeat(lockPath: string, now: () => Date, everyMs = 60_000): () => void {
  const timer = setInterval(() => {
    try {
      if (existsSync(lockPath)) writeFileSync(lockPath, now().toISOString());
    } catch {
      // the lock is only a courtesy to the next run
    }
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

/** The detached child of `hub sync --auto`. Syncs tracked projects only, logs one line, never throws. */
export async function runAutoChild(opts: SyncOptions): Promise<void> {
  const now = opts.now ?? (() => new Date());
  const lockPath = join(opts.hubDir, 'auto.lock');
  const logPath = join(opts.hubDir, 'auto.log');
  let locked = false;
  let stopHeartbeat = (): void => {};
  try {
    mkdirSync(opts.hubDir, { recursive: true });
    if (!takeLock(lockPath, now())) return;
    locked = true;
    stopHeartbeat = startLockHeartbeat(lockPath, now);
    const { project: _project, session: _session, dryRun: _dryRun, ...rest } = opts;
    let line: string;
    try {
      const r = await runSync({ ...rest, trigger: 'auto' });
      const counts = `${r.uploaded.length} uploaded, ${r.unchanged} unchanged, ${r.summarized.length} summarized, ${r.waiting.count} waiting`;
      line =
        r.errors.length === 0
          ? `${now().toISOString()} ok ${counts}`
          : `${now().toISOString()} error ${counts}, ${r.errors.length} errors: ${r.errors[0]}`;
    } catch (e) {
      line = `${now().toISOString()} error 0 uploaded, 0 unchanged, 0 summarized, 0 waiting, 1 errors: ${(e as Error).message}`;
    }
    writeFileSync(logPath, [...readLines(logPath), line.replace(/\r?\n/g, ' ')].slice(-LOG_KEEP).join('\n') + '\n');
  } catch {
    // nothing may reach the terminal or the caller
  } finally {
    stopHeartbeat();
    if (locked) {
      try {
        unlinkSync(lockPath);
      } catch {
        // best effort
      }
    }
  }
}
