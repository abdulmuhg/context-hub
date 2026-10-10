import { execFileSync } from 'node:child_process';
import { normalizeRemote } from '@context-hub/core';

export type GitRunner = (cwd: string, args: string[]) => string | null;

export interface ResolveDeps {
  git: GitRunner;
  exists: (path: string) => boolean;
}

export interface ResolveInput {
  cwd: string | null;
  /** A remote URL the tool itself recorded, if any. */
  remoteHint: string | null;
  /** Absolute paths seen in tool calls, used when there is no cwd. */
  pathHints: string[];
}

export const realGit: GitRunner = (cwd, args) => {
  try {
    const out = execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
    return out === '' ? null : out;
  } catch {
    return null;
  }
};

function baseName(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function parentDir(p: string): string | null {
  const trimmed = p.replace(/[\\/]+$/, '');
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return i > 0 ? trimmed.slice(0, i) : null;
}

function keyForExistingDir(dir: string, git: GitRunner): string {
  const remote = git(dir, ['remote', 'get-url', 'origin']);
  const key = remote ? normalizeRemote(remote) : null;
  if (key) return key;
  const top = git(dir, ['rev-parse', '--show-toplevel']);
  return `local:${baseName(top ?? dir)}`;
}

/** The repo key for a hint path, or null if it is not inside a git repo. */
function repoKeyForHint(hint: string, deps: ResolveDeps): string | null {
  let dir: string | null = hint;
  while (dir && !deps.exists(dir)) dir = parentDir(dir);
  if (!dir) return null;
  if (deps.git(dir, ['rev-parse', '--show-toplevel']) === null) return null;
  return keyForExistingDir(dir, deps.git);
}

export function resolveProjectKey(input: ResolveInput, deps: ResolveDeps): string {
  if (input.remoteHint) {
    const hinted = normalizeRemote(input.remoteHint);
    if (hinted) return hinted;
  }
  if (input.cwd) {
    if (!deps.exists(input.cwd)) return `local:${baseName(input.cwd)}`;
    return keyForExistingDir(input.cwd, deps.git);
  }
  const votes = new Map<string, number>();
  for (const hint of input.pathHints) {
    const key = repoKeyForHint(hint, deps);
    if (key) votes.set(key, (votes.get(key) ?? 0) + 1);
  }
  const winner = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
  return winner ? winner[0] : 'unfiled';
}

export function applyOverrides(
  key: string,
  sessionKey: string,
  overrides: { aliases: Record<string, string>; assignments: Record<string, string> },
): string {
  return overrides.assignments[sessionKey] ?? overrides.aliases[key] ?? key;
}

/** Does what the user typed (a key, a name or a remote URL) refer to this key? */
export function projectMatches(input: string, key: string): boolean {
  const wanted = (normalizeRemote(input) ?? input).toLowerCase();
  const k = key.toLowerCase();
  if (k === wanted || k === `local:${wanted}`) return true;
  return k.split('/').pop() === wanted;
}
