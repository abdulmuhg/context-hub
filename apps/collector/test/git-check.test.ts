import { describe, expect, it } from 'vitest';
import type { State } from '../src/config.js';
import { prepareGitChecks } from '../src/git-check.js';
import type { CommandRunner } from '../src/git-facts.js';

const KEY = 'github.com/me/alpha';
const NOW = new Date(2026, 9, 22, 11, 30);

/** A fake repo at /work/alpha. `remote` is what origin points at. */
const deps = (remote: string, run: CommandRunner = okRunner) => ({
  exists: (p: string) => p.startsWith('/work'),
  git: (cwd: string, args: string[]) => {
    if (!cwd.startsWith('/work')) return null;
    if (args[0] === 'remote') return remote;
    if (args.includes('--git-common-dir')) return `${cwd}/.git`;
    return cwd;
  },
  run,
});

const okRunner: CommandRunner = (cmd, _cwd, args) => {
  const k = `${cmd} ${args.join(' ')}`;
  if (k === 'git symbolic-ref --short refs/remotes/origin/HEAD') return 'origin/main';
  if (k.startsWith('git log')) return '3e21fd9\t2026-10-22\tMerge pull request #20';
  if (k.startsWith('git fetch')) return '';
  if (k.startsWith('gh pr list')) return '[]';
  return '';
};

const state = (repos: Record<string, string>): State => ({ fingerprint: '', files: {}, repos });
const o = { now: NOW, computer: 'PC' };

describe('prepareGitChecks', () => {
  it('prepares facts, a section and a hash for a project with a good checkout', () => {
    const { checks, skipped } = prepareGitChecks([KEY], state({ [KEY]: '/work/alpha' }), deps('git@github.com:me/alpha.git'), o);
    expect(skipped).toEqual([]);
    const check = checks.get(KEY)!;
    expect(check.section).toContain('checked on PC');
    expect(check.facts).toContain('3e21fd9');
    expect(check.as_of).toBe(NOW.toISOString());
    expect(check.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('drops a recorded path that now resolves to another project', () => {
    const s = state({ [KEY]: '/work/alpha' });
    const { checks, skipped } = prepareGitChecks([KEY], s, deps('git@github.com:me/other.git'), o);
    expect(checks.size).toBe(0);
    expect(skipped).toEqual([{ project: KEY, reason: 'no checkout on this computer' }]);
    expect(s.repos).toEqual({});
  });

  it('follows an alias when it confirms the path', () => {
    const { checks } = prepareGitChecks([KEY], state({ [KEY]: '/work/alpha' }), deps('git@github.com:me/old.git'), { ...o, aliases: { 'github.com/me/old': KEY } });
    expect(checks.has(KEY)).toBe(true);
  });

  it('skips a project with no recorded path, or whose path is gone', () => {
    const s = state({ [KEY]: '/gone/alpha' });
    const out = prepareGitChecks([KEY, 'github.com/me/none'], s, deps('git@github.com:me/alpha.git'), o);
    expect(out.skipped.map((x) => x.project)).toEqual([KEY, 'github.com/me/none']);
    expect(s.repos).toEqual({});
  });

  it('skips a project when git finds no default branch', () => {
    const { skipped } = prepareGitChecks([KEY], state({ [KEY]: '/work/alpha' }), deps('git@github.com:me/alpha.git', () => null), o);
    expect(skipped).toEqual([{ project: KEY, reason: 'git found no default branch' }]);
  });
});
