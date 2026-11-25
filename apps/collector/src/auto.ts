import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Fail } from './errors.js';
import { LOCK_FILE, markRerun, releaseLock, RERUN_FILE, startLockHeartbeat, takeLock, takeRerun, type Held } from './lock.js';
import { runSync, type SyncOptions } from './sync.js';

const HOOK_SUFFIX = ' sync --auto';
const LOG_KEEP = 200;

type Json = Record<string, unknown>;

export function hookCommand(nodePath: string, bundlePath: string, hook?: 'antigravity'): string {
  const extra = hook === 'antigravity' ? ' --hook antigravity' : '';
  return `"${nodePath}" "${bundlePath}"${HOOK_SUFFIX}${extra}`;
}

/**
 * True for a hook that runs our sync, wherever node and the bundle are: `"node" "…/hub.mjs" sync --auto`, or
 * `…/bin.js` for a hook written from a clone's build. Another tool's `sync --auto` hook is never ours.
 */
export function isOurHook(command: unknown): boolean {
  return typeof command === 'string' && /^"[^"\r\n]+" "[^"\r\n]*[\\/](?:hub\.mjs|bin\.js)" sync --auto(?: --hook antigravity)?$/.test(command);
}

function notJson(label: string, hint: string): Error {
  return new Fail(`${label} is not valid JSON, so it was not changed.${hint}`);
}

/** Returns null when the file does not exist. Throws when it is not a JSON object. */
function readJsonObject(path: string, label: string, hint: string): Json | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw notJson(label, hint);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw notJson(label, hint);
  return parsed as Json;
}

function writeJsonObject(path: string, settings: Json, hadFile: boolean): void {
  mkdirSync(dirname(path), { recursive: true });
  if (hadFile) copyFileSync(path, `${path}.hub-backup`);
  const tmp = `${path}.hub-tmp`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  renameSync(tmp, path);
}

const CLAUDE_LABEL = '~/.claude/settings.json';
const AGY_LABEL = '~/.gemini/config/hooks.json';
const AGY_HOOK_NAME = 'context-hub';

function sessionEnd(settings: Json, hint: string): unknown[] {
  const hooks = settings.hooks;
  if (hooks === undefined) return [];
  if (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)) throw notJson(CLAUDE_LABEL, hint);
  const list = (hooks as Json).SessionEnd;
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw notJson(CLAUDE_LABEL, hint);
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
  writeJsonObject(settingsPath, settings, true);
}

/** Rewrites every hook of ours to run `command`, keeping only one. Writes nothing when nothing changes. */
export function repointHook(settingsPath: string, command: string): { repointed: number } {
  const hint = ` Fix it or add the hook by hand: ${command}`;
  const settings = readJsonObject(settingsPath, CLAUDE_LABEL, hint);
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
  const settings = readJsonObject(settingsPath, CLAUDE_LABEL, hint);
  const list = sessionEnd(settings ?? {}, hint);
  if (list.some((e) => commandsOf(e).some(isOurHook))) return { changed: repointHook(settingsPath, command).repointed > 0 };
  const next: Json = settings ?? {};
  const hooks = { ...((next.hooks as Json | undefined) ?? {}) };
  hooks.SessionEnd = [...list, { hooks: [{ type: 'command', command, timeout: 10 }] }];
  next.hooks = hooks;
  writeJsonObject(settingsPath, next, settings !== null);
  return { changed: true };
}

/** Turns auto sync off by removing every hook of ours: two would start two syncs. */
export function autoOff(settingsPath: string): { removed: number } {
  const settings = readJsonObject(settingsPath, CLAUDE_LABEL, '');
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
    const settings = readJsonObject(settingsPath, CLAUDE_LABEL, '');
    if (settings) on = sessionEnd(settings, '').some((e) => commandsOf(e).some(isOurHook));
  } catch {
    // an unreadable settings file means the hook is not (reliably) on
  }
  return { on, lastLine: readLines(logPath).at(-1) ?? null };
}

function antigravityStop(hooksFile: Json, hint: string): unknown[] {
  const group = hooksFile[AGY_HOOK_NAME];
  if (group === undefined) return [];
  if (group === null || typeof group !== 'object' || Array.isArray(group)) throw notJson(AGY_LABEL, hint);
  const list = (group as Json).Stop;
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw notJson(AGY_LABEL, hint);
  return list;
}

function rewriteFlatOurs(list: unknown[], command: string | null): { list: unknown[]; found: number } {
  let found = 0;
  let placed = false;
  const next: unknown[] = [];
  for (const h of list) {
    if (!isOurHook((h as Json | null)?.command)) {
      next.push(h);
      continue;
    }
    found++;
    if (command !== null && !placed) {
      placed = true;
      next.push({ ...(h as Json), command });
    }
  }
  return { list: next, found };
}

function storeAntigravity(hooksFile: Json, hooksPath: string, list: unknown[]): void {
  const group = { ...((hooksFile[AGY_HOOK_NAME] as Json | undefined) ?? {}) };
  if (list.length > 0) group.Stop = list;
  else delete group.Stop;
  if (Object.keys(group).length > 0) hooksFile[AGY_HOOK_NAME] = group;
  else delete hooksFile[AGY_HOOK_NAME];
  writeJsonObject(hooksPath, hooksFile, true);
}

/** Rewrites our Antigravity Stop hook to `command`, keeping only one. */
export function antigravityRepointHook(hooksPath: string, command: string): { repointed: number } {
  const hint = ` Fix it or add the hook by hand: ${command}`;
  const hooksFile = readJsonObject(hooksPath, AGY_LABEL, hint);
  if (!hooksFile) return { repointed: 0 };
  const list = antigravityStop(hooksFile, hint);
  const { list: next, found } = rewriteFlatOurs(list, command);
  if (found === 0 || JSON.stringify(next) === JSON.stringify(list)) return { repointed: 0 };
  storeAntigravity(hooksFile, hooksPath, next);
  return { repointed: found };
}

/** Turns Antigravity Stop hook auto sync on in ~/.gemini/config/hooks.json. */
export function antigravityAutoOn(hooksPath: string, command: string): { changed: boolean } {
  const hint = ` Fix it or add the hook by hand: ${command}`;
  const hooksFile = readJsonObject(hooksPath, AGY_LABEL, hint);
  const list = antigravityStop(hooksFile ?? {}, hint);
  if (list.some((h) => isOurHook((h as Json | null)?.command))) {
    return { changed: antigravityRepointHook(hooksPath, command).repointed > 0 };
  }
  const next: Json = hooksFile ?? {};
  const group = { ...((next[AGY_HOOK_NAME] as Json | undefined) ?? {}) };
  group.Stop = [...list, { type: 'command', command, timeout: 10 }];
  next[AGY_HOOK_NAME] = group;
  writeJsonObject(hooksPath, next, hooksFile !== null);
  return { changed: true };
}

/** Turns Antigravity Stop hook auto sync off by removing our handler from ~/.gemini/config/hooks.json. */
export function antigravityAutoOff(hooksPath: string): { removed: number } {
  const hooksFile = readJsonObject(hooksPath, AGY_LABEL, '');
  if (!hooksFile) return { removed: 0 };
  const { list, found } = rewriteFlatOurs(antigravityStop(hooksFile, ''), null);
  if (found === 0) return { removed: 0 };
  storeAntigravity(hooksFile, hooksPath, list);
  return { removed: found };
}

export function antigravityAutoStatus(hooksPath: string, logPath: string): { on: boolean; lastLine: string | null } {
  let on = false;
  try {
    const hooksFile = readJsonObject(hooksPath, AGY_LABEL, '');
    if (hooksFile) on = antigravityStop(hooksFile, '').some((h) => isOurHook((h as Json | null)?.command));
  } catch {
    // an unreadable hooks file means the hook is not (reliably) on
  }
  return { on, lastLine: readLines(logPath).at(-1) ?? null };
}

const MAX_PASSES = 3;

/**
 * The detached child of `hub sync --auto`. Syncs tracked projects only, logs one line per pass, never throws.
 * A child that finds the lock held leaves a rerun flag; the holder runs another pass for it (at most MAX_PASSES).
 * `onPassEnd`, `beforeRelease` and `afterMarkRerun` are for tests; production leaves them unset.
 */
export async function runAutoChild(
  opts: SyncOptions & { onPassEnd?: (pass: number) => void; beforeRelease?: () => void; afterMarkRerun?: () => void },
): Promise<void> {
  const now = opts.now ?? (() => new Date());
  const lockPath = join(opts.hubDir, LOCK_FILE);
  const logPath = join(opts.hubDir, 'auto.log');
  const rerunPath = join(opts.hubDir, RERUN_FILE);
  let held: Held | null = null;
  let stopHeartbeat = (): void => {};
  try {
    mkdirSync(opts.hubDir, { recursive: true });
    const { project: _project, session: _session, dryRun: _dryRun, onPassEnd, beforeRelease, afterMarkRerun, ...rest } = opts;
    held = takeLock(lockPath, now());
    if (!held) {
      // Flag first, then one more try: the holder may have checked for the flag before it was written.
      markRerun(opts.hubDir);
      afterMarkRerun?.();
      held = takeLock(lockPath, now());
      if (!held) return;
    }
    let passes = 0;
    while (held) {
      stopHeartbeat = startLockHeartbeat(held, now);
      for (;;) {
        takeRerun(opts.hubDir); // before the pass, so a flag set during it survives
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
        passes++;
        onPassEnd?.(passes);
        if (passes < MAX_PASSES && existsSync(rerunPath)) continue;
        break;
      }
      stopHeartbeat();
      stopHeartbeat = (): void => {};
      beforeRelease?.();
      releaseLock(held);
      held = null;
      // A child that lost the race just before the release left a flag nobody is left to drain.
      if (passes < MAX_PASSES && existsSync(rerunPath)) held = takeLock(lockPath, now());
    }
  } catch {
    // nothing may reach the terminal or the caller
  } finally {
    stopHeartbeat();
    if (held) releaseLock(held);
  }
}
