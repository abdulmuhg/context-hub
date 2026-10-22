import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { stripSecrets } from '@context-hub/core';

/**
 * Runs one git or gh command in `cwd`. Returns its trimmed output, which is ''
 * when it succeeded without printing, and null when it failed or timed out.
 */
export type CommandRunner = (cmd: 'git' | 'gh', cwd: string, args: string[], timeoutMs: number) => string | null;

export const GIT_TIMEOUT_MS = 5000;
export const FETCH_TIMEOUT_MS = 20_000;
export const GH_TIMEOUT_MS = 15_000;

export const realRunner: CommandRunner = (cmd, cwd, args, timeoutMs) => {
  try {
    return execFileSync(cmd, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: timeoutMs,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' },
    }).trim();
  } catch {
    return null;
  }
};

export interface Commit {
  hash: string;
  date: string;
  subject: string;
}

export interface Pr {
  number: number;
  title: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  branch: string;
  closed_at: string | null;
}

export interface RepoFacts {
  /** False when the remote could not be reached, so the facts may be behind. */
  fetched: boolean;
  /** Whether the project lives on GitHub, so that missing PR facts are worth a mention. */
  github: boolean;
  /** The default branch, without "origin/". */
  branch: string;
  /** Newest first, at most 15; the first is the tip. */
  commits: Commit[];
  /** Local branches other than the default branch. */
  branches: { name: string; merged: boolean; gone: boolean }[];
  /** Null when there are no PR facts. */
  prs: Pr[] | null;
}

const COMMITS = 15;
const PR_LIMIT = 20;
const LIST_MAX = 5;
const RECENT_DAYS = 14;
const FACTS_MAX_CHARS = 4000;
const TITLE_MAX_CHARS = 120;

const lines = (s: string | null): string[] => (s ? s.split('\n').filter((l) => l.trim() !== '') : []);

function defaultRef(dir: string, run: CommandRunner): string | null {
  const head = run('git', dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], GIT_TIMEOUT_MS);
  if (head) return head;
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
    if (run('git', dir, ['rev-parse', '--verify', '--quiet', ref], GIT_TIMEOUT_MS)) return ref;
  }
  return null;
}

function parsePrs(out: string | null): Pr[] | null {
  if (!out) return null;
  try {
    const list: unknown = JSON.parse(out);
    if (!Array.isArray(list)) return null;
    return list.flatMap((p): Pr[] => {
      if (typeof p?.number !== 'number' || typeof p.title !== 'string') return [];
      if (p.state !== 'OPEN' && p.state !== 'MERGED' && p.state !== 'CLOSED') return [];
      const closed = p.mergedAt ?? p.closedAt;
      return [{ number: p.number, title: p.title, state: p.state, branch: String(p.headRefName ?? ''), closed_at: typeof closed === 'string' ? closed : null }];
    });
  } catch {
    return null;
  }
}

/** Reads the facts about one checkout. Null when no default branch is found. */
export function gatherFacts(dir: string, key: string, run: CommandRunner): RepoFacts | null {
  const fetched = run('git', dir, ['fetch', '--quiet', '--prune', 'origin'], FETCH_TIMEOUT_MS) !== null;
  const ref = defaultRef(dir, run);
  if (!ref) return null;
  const branch = ref.replace(/^origin\//, '');

  const commits = lines(run('git', dir, ['log', `-${COMMITS}`, '--format=%h%x09%cs%x09%s', ref], GIT_TIMEOUT_MS)).map((l) => {
    const [hash = '', date = '', ...subject] = l.split('\t');
    return { hash, date, subject: subject.join('\t') };
  });

  const merged = new Set(lines(run('git', dir, ['branch', '--format=%(refname:short)', '--merged', ref], GIT_TIMEOUT_MS)));
  const branches = lines(run('git', dir, ['for-each-ref', 'refs/heads', '--format=%(refname:short)%x09%(upstream:track)'], GIT_TIMEOUT_MS))
    .map((l) => {
      const [name = '', track = ''] = l.split('\t');
      return { name, merged: merged.has(name), gone: track.includes('gone') };
    })
    .filter((b) => b.name !== branch);

  const github = key.startsWith('github.com/');
  const prs = github
    ? parsePrs(run('gh', dir, ['pr', 'list', '--state', 'all', '--limit', String(PR_LIMIT), '--json', 'number,title,state,headRefName,mergedAt,closedAt'], GH_TIMEOUT_MS))
    : null;
  return { fetched, github, branch, commits, branches, prs };
}

/** The facts as plain text for the review. At most 4,000 characters, with secrets removed. */
export function renderFacts(f: RepoFacts): string {
  const title = (t: string) => (t.length > TITLE_MAX_CHARS ? `${t.slice(0, TITLE_MAX_CHARS)}...` : t);
  const out = [`Default branch: ${f.branch}${f.fetched ? '' : ' (the remote could not be reached, so this may be behind)'}`, 'Recent commits on it, newest first:'];
  for (const c of f.commits) out.push(`- ${c.hash} ${c.date} ${title(c.subject)}`);
  out.push('Local branches (besides the default branch):');
  for (const b of f.branches) out.push(`- ${b.name}: ${b.merged ? 'merged into the default branch' : 'not merged'}${b.gone ? ', upstream gone' : ''}`);
  if (f.branches.length === 0) out.push('(none)');
  if (f.prs === null) {
    out.push('Pull requests: no facts');
  } else {
    out.push('Pull requests, most recent first:');
    for (const p of f.prs) out.push(`- #${p.number} ${p.state}${p.closed_at ? ` ${p.closed_at.slice(0, 10)}` : ''} (${p.branch}): ${title(p.title)}`);
    if (f.prs.length === 0) out.push('(none)');
  }
  return stripSecrets(out.join('\n').slice(0, FACTS_MAX_CHARS)).text;
}

/** Identifies the facts, so a check can tell whether anything changed since the last one. */
export function factsHash(f: RepoFacts): string {
  return createHash('sha256').update(JSON.stringify(f)).digest('hex');
}

const pad = (n: number) => String(n).padStart(2, '0');

/** A list cut at five entries, with how many were left out. */
function cut(items: string[]): string {
  return items.length <= LIST_MAX ? items.join(', ') : `${items.slice(0, LIST_MAX).join(', ')}, and ${items.length - LIST_MAX} more`;
}

/** The page's "## Git" section, written from the facts without a model. Times are local. */
export function renderSection(f: RepoFacts, o: { computer: string; at: Date }): string {
  const { at } = o;
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const bullets: string[] = [];
  const tip = f.commits[0];
  if (tip) bullets.push(`\`${f.branch}\` at ${tip.hash} (${tip.date}): ${tip.subject}`);
  const prs = f.prs ?? [];
  const open = prs.filter((p) => p.state === 'OPEN');
  if (open.length > 0) bullets.push(`Open PRs: ${cut(open.map((p) => `#${p.number} ${p.title} (${p.branch})`))}`);
  const since = at.getTime() - RECENT_DAYS * 86_400_000;
  const recent = prs.filter((p) => p.state !== 'OPEN' && p.closed_at !== null && Date.parse(p.closed_at) >= since);
  if (recent.length > 0) bullets.push(`Merged or closed in the last ${RECENT_DAYS} days: ${cut(recent.map((p) => `#${p.number}`))}`);
  const open_branches = f.branches.filter((b) => !b.merged);
  if (open_branches.length > 0) bullets.push(`Local branches not merged: ${cut(open_branches.map((b) => (b.gone ? `${b.name} (upstream gone)` : b.name)))}`);
  if (!f.fetched) bullets.push('Not fetched: the remote could not be reached');
  if (f.github && f.prs === null) bullets.push('No PR facts: gh is not installed or not signed in');
  return [`## Git (checked on ${o.computer}, ${stamp})`, '', ...bullets.map((b) => `- ${b}`)].join('\n');
}
