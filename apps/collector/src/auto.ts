import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runSync, type SyncOptions } from './sync.js';

const HOOK_SUFFIX = ' sync --auto';
const LOCK_MAX_AGE_MS = 10 * 60 * 1000;
const LOG_KEEP = 200;

type Json = Record<string, unknown>;

export function hookCommand(nodePath: string, bundlePath: string): string {
  return `"${nodePath}" "${bundlePath}"${HOOK_SUFFIX}`;
}

function isOurs(command: unknown, bundleName?: string): boolean {
  return typeof command === 'string' && command.endsWith(HOOK_SUFFIX) && (bundleName === undefined || command.includes(bundleName));
}

function notJson(hint: string): Error {
  return new Error(`~/.claude/settings.json is not valid JSON, so it was not changed.${hint}`);
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

export function autoOn(settingsPath: string, command: string): { changed: boolean } {
  const hint = ` Fix it or add the hook by hand: ${command}`;
  const settings = readSettings(settingsPath, hint);
  const list = sessionEnd(settings ?? {}, hint);
  if (list.some((e) => commandsOf(e).includes(command))) return { changed: false };
  const next: Json = settings ?? {};
  const hooks = { ...((next.hooks as Json | undefined) ?? {}) };
  hooks.SessionEnd = [...list, { hooks: [{ type: 'command', command, timeout: 10 }] }];
  next.hooks = hooks;
  writeSettings(settingsPath, next, settings !== null);
  return { changed: true };
}

export function autoOff(settingsPath: string, bundleName: string): { removed: number } {
  const settings = readSettings(settingsPath, '');
  if (!settings) return { removed: 0 };
  const list = sessionEnd(settings, '');
  let removed = 0;
  const kept: unknown[] = [];
  for (const entry of list) {
    const inner = (entry as Json | null)?.hooks;
    if (!Array.isArray(inner)) {
      kept.push(entry);
      continue;
    }
    const rest = inner.filter((h) => !isOurs((h as Json | null)?.command, bundleName));
    removed += inner.length - rest.length;
    if (rest.length === inner.length) kept.push(entry);
    else if (rest.length > 0) kept.push({ ...(entry as Json), hooks: rest });
  }
  if (removed === 0) return { removed: 0 };
  const hooks = { ...(settings.hooks as Json) };
  if (kept.length > 0) hooks.SessionEnd = kept;
  else delete hooks.SessionEnd;
  if (Object.keys(hooks).length > 0) settings.hooks = hooks;
  else delete settings.hooks;
  writeSettings(settingsPath, settings, true);
  return { removed };
}

function readLines(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split(/\r?\n/).filter((l) => l !== '');
}

export function autoStatus(settingsPath: string, logPath: string): { on: boolean; lastLine: string | null } {
  let on = false;
  try {
    const settings = readSettings(settingsPath, '');
    if (settings) on = sessionEnd(settings, '').some((e) => commandsOf(e).some((c) => isOurs(c)));
  } catch {
    // an unreadable settings file means the hook is not (reliably) on
  }
  return { on, lastLine: readLines(logPath).at(-1) ?? null };
}

/** Takes the lock, or returns false when a younger one exists. A stale lock is taken over. */
function takeLock(lockPath: string, now: Date): boolean {
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

/** The detached child of `hub sync --auto`. Syncs tracked projects only, logs one line, never throws. */
export async function runAutoChild(opts: SyncOptions): Promise<void> {
  const now = opts.now ?? (() => new Date());
  const lockPath = join(opts.hubDir, 'auto.lock');
  const logPath = join(opts.hubDir, 'auto.log');
  let locked = false;
  try {
    mkdirSync(opts.hubDir, { recursive: true });
    if (!takeLock(lockPath, now())) return;
    locked = true;
    const { project: _project, session: _session, dryRun: _dryRun, ...rest } = opts;
    let line: string;
    try {
      const r = await runSync(rest);
      const counts = `${r.uploaded.length} uploaded, ${r.unchanged} unchanged`;
      line =
        r.errors.length === 0
          ? `${now().toISOString()} ok ${counts}`
          : `${now().toISOString()} error ${counts}, ${r.errors.length} errors: ${r.errors[0]}`;
    } catch (e) {
      line = `${now().toISOString()} error 0 uploaded, 0 unchanged, 1 errors: ${(e as Error).message}`;
    }
    writeFileSync(logPath, [...readLines(logPath), line.replace(/\r?\n/g, ' ')].slice(-LOG_KEEP).join('\n') + '\n');
  } catch {
    // nothing may reach the terminal or the caller
  } finally {
    if (locked) {
      try {
        unlinkSync(lockPath);
      } catch {
        // best effort
      }
    }
  }
}
