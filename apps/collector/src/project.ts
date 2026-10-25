import { execFileSync } from 'node:child_process';
import { normalizeRemote } from '@context-hub/core';
import { quietOptions } from './git-facts.js';

export type GitRunner = (cwd: string, args: string[]) => string | null;

export interface ResolveDeps {
  git: GitRunner;
  exists: (path: string) => boolean;
}

export interface ResolveInput {
  cwd: string | null;
  /**
   * The folder of every record, in order. When given, the project is decided
   * by vote over these rather than by `cwd` alone, so a session that starts in
   * a scratch folder and does its work in a repo is filed under the repo.
   */
  cwds?: readonly string[];
  /** A remote URL the tool itself recorded, if any. */
  remoteHint: string | null;
  /** Absolute paths seen in tool calls, used when there is no cwd. */
  pathHints: string[];
}

export const realGit: GitRunner = (cwd, args) => {
  try {
    const out = execFileSync('git', ['-C', cwd, ...args], quietOptions(undefined, 5000)).trim();
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

/** Claude Code puts a worktree at "<repo>/.claude/worktrees/<name>" and removes it when done. */
const CLAUDE_WORKTREE = /^(.+?)[\\/]\.claude[\\/]worktrees[\\/][^\\/]+/;

/**
 * The main checkout of the repo a folder is in, and the project key of that
 * checkout. A linked or removed Claude Code worktree gives its repo, not its own
 * folder, since the worktree goes away. Null outside a repo.
 */
export function checkoutFor(dir: string, deps: ResolveDeps): { path: string; key: string } | null {
  let at = dir;
  if (!deps.exists(dir)) {
    const repo = CLAUDE_WORKTREE.exec(dir)?.[1];
    if (!repo || !deps.exists(repo)) return null;
    at = repo;
  }
  const common = deps.git(at, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const path = (common && baseName(common) === '.git' ? parentDir(common) : null) ?? deps.git(at, ['rev-parse', '--show-toplevel']);
  if (!path) return null;
  return { path, key: keyForExistingDir(path, deps.git) };
}

function keyForCwd(cwd: string, deps: ResolveDeps): string {
  if (deps.exists(cwd)) return keyForExistingDir(cwd, deps.git);
  const repo = CLAUDE_WORKTREE.exec(cwd)?.[1];
  if (repo && deps.exists(repo)) return keyForExistingDir(repo, deps.git);
  return `local:${baseName(cwd)}`;
}

/**
 * The project with the most records. Folders are resolved first, so two
 * spellings of one repo, or a repo and its subfolder, count together. On a
 * tie the project worked in last wins, as the better guess at where the work
 * went.
 */
function votedKey(cwds: readonly string[], deps: ResolveDeps): string {
  const keyOf = new Map<string, string>();
  const votes = new Map<string, { count: number; last: number }>();
  cwds.forEach((cwd, i) => {
    let key = keyOf.get(cwd);
    if (key === undefined) {
      key = keyForCwd(cwd, deps);
      keyOf.set(cwd, key);
    }
    const v = votes.get(key) ?? { count: 0, last: 0 };
    votes.set(key, { count: v.count + 1, last: i });
  });
  let best = '';
  let score = { count: 0, last: -1 };
  for (const [key, v] of votes) {
    if (v.count > score.count || (v.count === score.count && v.last > score.last)) {
      best = key;
      score = v;
    }
  }
  return best;
}

export function resolveProjectKey(input: ResolveInput, deps: ResolveDeps): string {
  if (input.remoteHint) {
    const hinted = normalizeRemote(input.remoteHint);
    if (hinted) return hinted;
  }
  if (input.cwds && input.cwds.length > 0) return votedKey(input.cwds, deps);
  if (input.cwd) return keyForCwd(input.cwd, deps);
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
