import { describe, expect, it } from 'vitest';
import { applyOverrides, projectMatches, resolveProjectKey, type ResolveDeps } from '../src/project.js';

/** A fake git: `repos` maps a directory to its remote (or null) and top-level folder. */
function deps(repos: Record<string, { remote: string | null; top: string }>, missing: string[] = []): ResolveDeps {
  const find = (cwd: string) =>
    Object.entries(repos)
      .filter(([dir]) => cwd === dir || cwd.startsWith(dir + '/'))
      .sort((a, b) => b[0].length - a[0].length)[0]?.[1];
  return {
    exists: (p) => !missing.includes(p),
    git: (cwd, args) => {
      const repo = find(cwd);
      if (!repo) return null;
      if (args[0] === 'remote') return repo.remote;
      if (args[0] === 'rev-parse') return repo.top;
      return null;
    },
  };
}

const none = { cwd: null, remoteHint: null, pathHints: [] };

describe('resolveProjectKey', () => {
  it('uses the git remote', () => {
    const d = deps({ '/work/jsonroom': { remote: 'git@github.com:abdulmuhg/jsonroom.git', top: '/work/jsonroom' } });
    expect(resolveProjectKey({ ...none, cwd: '/work/jsonroom' }, d)).toBe('github.com/abdulmuhg/jsonroom');
  });

  it('maps a subfolder and a worktree to the same key', () => {
    const repo = { remote: 'https://github.com/abdulmuhg/jsonroom.git', top: '/work/jsonroom' };
    const d = deps({ '/work/jsonroom': repo, '/work/jsonroom-wt/fix': repo });
    expect(resolveProjectKey({ ...none, cwd: '/work/jsonroom/src' }, d)).toBe('github.com/abdulmuhg/jsonroom');
    expect(resolveProjectKey({ ...none, cwd: '/work/jsonroom-wt/fix' }, d)).toBe('github.com/abdulmuhg/jsonroom');
  });

  it('uses the top-level folder name when the repo has no remote', () => {
    const d = deps({ '/work/notes': { remote: null, top: '/work/notes' } });
    expect(resolveProjectKey({ ...none, cwd: '/work/notes/drafts' }, d)).toBe('local:notes');
  });

  it('uses the folder name when it is not a git repo', () => {
    expect(resolveProjectKey({ ...none, cwd: '/tmp/scratch' }, deps({}))).toBe('local:scratch');
  });

  it('uses the folder name when the folder no longer exists', () => {
    expect(resolveProjectKey({ ...none, cwd: 'C:\\old\\gone' }, deps({}, ['C:\\old\\gone']))).toBe('local:gone');
  });

  it('prefers a remote hint recorded by the tool', () => {
    const input = { cwd: '/tmp/x', remoteHint: 'https://github.com/abdulmuhg/harmonize.git', pathHints: [] };
    expect(resolveProjectKey(input, deps({}))).toBe('github.com/abdulmuhg/harmonize');
  });

  it('returns unfiled when there is no folder and no hint', () => {
    expect(resolveProjectKey(none, deps({}))).toBe('unfiled');
  });

  it('infers the project from path hints by majority', () => {
    const d = deps({
      '/work/a': { remote: 'git@github.com:me/a.git', top: '/work/a' },
      '/work/b': { remote: 'git@github.com:me/b.git', top: '/work/b' },
    });
    const input = { ...none, pathHints: ['/work/a/src', '/work/a/test', '/work/b'] };
    expect(resolveProjectKey(input, d)).toBe('github.com/me/a');
  });

  it('walks up from a path hint that does not exist to one that does', () => {
    const d = deps({ '/work/a': { remote: 'git@github.com:me/a.git', top: '/work/a' } }, ['/work/a/src/gone.ts']);
    expect(resolveProjectKey({ ...none, pathHints: ['/work/a/src/gone.ts'] }, d)).toBe('github.com/me/a');
  });

  it('returns unfiled when no path hint resolves to a repo', () => {
    expect(resolveProjectKey({ ...none, pathHints: ['/nowhere/x'] }, deps({}))).toBe('unfiled');
  });
});

describe('applyOverrides', () => {
  const o = { aliases: { 'local:jr': 'github.com/abdulmuhg/jsonroom' }, assignments: { 'codex:s9': 'local:special' } };

  it('applies an alias', () => {
    expect(applyOverrides('local:jr', 'claude-code:s1', o)).toBe('github.com/abdulmuhg/jsonroom');
  });

  it('lets a session assignment win over everything', () => {
    expect(applyOverrides('local:jr', 'codex:s9', o)).toBe('local:special');
  });

  it('leaves other keys alone', () => {
    expect(applyOverrides('local:other', 'claude-code:s1', o)).toBe('local:other');
  });
});

describe('projectMatches', () => {
  it.each([
    ['github.com/abdulmuhg/jsonroom', 'github.com/abdulmuhg/jsonroom'],
    ['jsonroom', 'github.com/abdulmuhg/jsonroom'],
    ['JsonRoom', 'github.com/abdulmuhg/jsonroom'],
    ['git@github.com:abdulmuhg/jsonroom.git', 'github.com/abdulmuhg/jsonroom'],
    ['notes', 'local:notes'],
    ['local:notes', 'local:notes'],
  ])('%s matches %s', (input, key) => {
    expect(projectMatches(input, key)).toBe(true);
  });

  it('does not match a different project', () => {
    expect(projectMatches('room', 'github.com/abdulmuhg/jsonroom')).toBe(false);
  });
});
