import { describe, expect, it } from 'vitest';
import { factsHash, gatherFacts, quietEnv, quietOptions, renderFacts, renderSection, type CommandRunner, type Pr, type RepoFacts } from '../src/git-facts.js';

const GH_LIST = 'gh pr list --state all --limit 20 --json number,title,state,headRefName,mergedAt,closedAt';
const LOG = 'git log -15 --format=%h%x09%cs%x09%s';

/** A runner that answers from a table keyed on "cmd arg arg"; anything else fails. Records the calls. */
function fake(table: Record<string, string | null>): CommandRunner & { calls: string[] } {
  const calls: string[] = [];
  const run = ((cmd: string, _cwd: string, args: string[]) => {
    const k = `${cmd} ${args.join(' ')}`;
    calls.push(k);
    return k in table ? table[k]! : null;
  }) as unknown as CommandRunner & { calls: string[] };
  run.calls = calls;
  return run;
}

const GOOD: Record<string, string | null> = {
  'git fetch --quiet --prune origin': '',
  'git symbolic-ref --short refs/remotes/origin/HEAD': 'origin/main',
  [`${LOG} origin/main`]: '3e21fd9\t2026-10-22\tMerge pull request #20 from abdulmuhg/lean-get-project\ne55eac0\t2026-10-21\tGive each session only its goal',
  'git for-each-ref refs/heads --format=%(refname:short)%09%(upstream:track)': 'main\t\nspike-x\t[gone]\ndone-x\t\nwip\t[ahead 1]',
  'git branch --format=%(refname:short) --merged origin/main': 'main\ndone-x',
  [GH_LIST]: JSON.stringify([
    { number: 21, title: 'Add the git check', state: 'OPEN', headRefName: 'git-reality-check', mergedAt: null, closedAt: null },
    { number: 20, title: 'Lean get_project', state: 'MERGED', headRefName: 'lean-get-project', mergedAt: '2026-10-22T08:00:00Z', closedAt: '2026-10-22T08:00:00Z' },
  ]),
};

describe('gatherFacts', () => {
  it('gathers the branch, commits, local branches and PRs', () => {
    const f = gatherFacts('/repo', 'github.com/me/alpha', fake(GOOD))!;
    expect(f.fetched).toBe(true);
    expect(f.branch).toBe('main');
    expect(f.commits).toEqual([
      { hash: '3e21fd9', date: '2026-10-22', subject: 'Merge pull request #20 from abdulmuhg/lean-get-project' },
      { hash: 'e55eac0', date: '2026-10-21', subject: 'Give each session only its goal' },
    ]);
    expect(f.branches).toEqual([
      { name: 'spike-x', merged: false, gone: true },
      { name: 'done-x', merged: true, gone: false },
      { name: 'wip', merged: false, gone: false },
    ]);
    expect(f.prs).toEqual([
      { number: 21, title: 'Add the git check', state: 'OPEN', branch: 'git-reality-check', closed_at: null },
      { number: 20, title: 'Lean get_project', state: 'MERGED', branch: 'lean-get-project', closed_at: '2026-10-22T08:00:00Z' },
    ]);
  });

  it('falls back to origin/master when there is no origin/HEAD', () => {
    const table: Record<string, string | null> = { ...GOOD, 'git symbolic-ref --short refs/remotes/origin/HEAD': null, 'git rev-parse --verify --quiet origin/master': 'abc' };
    delete table[`${LOG} origin/main`];
    table[`${LOG} origin/master`] = 'aaa1111\t2026-10-01\tinit';
    table['git branch --format=%(refname:short) --merged origin/master'] = 'master';
    const f = gatherFacts('/repo', 'github.com/me/alpha', fake(table))!;
    expect(f.branch).toBe('master');
    expect(f.commits[0]!.subject).toBe('init');
  });

  it('returns null when no branch resolves', () => {
    expect(gatherFacts('/repo', 'github.com/me/alpha', fake({ 'git fetch --quiet --prune origin': '' }))).toBeNull();
  });

  it('records a failed fetch', () => {
    expect(gatherFacts('/repo', 'github.com/me/alpha', fake({ ...GOOD, 'git fetch --quiet --prune origin': null }))!.fetched).toBe(false);
  });

  it('has no PR facts when gh fails or prints something that is not JSON', () => {
    expect(gatherFacts('/repo', 'github.com/me/alpha', fake({ ...GOOD, [GH_LIST]: null }))!.prs).toBeNull();
    expect(gatherFacts('/repo', 'github.com/me/alpha', fake({ ...GOOD, [GH_LIST]: 'not json' }))!.prs).toBeNull();
  });

  it('never calls gh for a project that is not on GitHub', () => {
    const run = fake(GOOD);
    expect(gatherFacts('/repo', 'local:alpha', run)!.prs).toBeNull();
    expect(run.calls.some((c) => c.startsWith('gh '))).toBe(false);
  });
});

const pr = (n: number, state: Pr['state'], closed_at: string | null = null, title = `Title ${n}`): Pr => ({ number: n, title, state, branch: `b${n}`, closed_at });
const base = (over: Partial<RepoFacts> = {}): RepoFacts => ({
  fetched: true,
  github: true,
  branch: 'main',
  commits: [{ hash: '3e21fd9', date: '2026-10-22', subject: 'Merge pull request #20' }],
  branches: [],
  prs: [],
  ...over,
});
const AT = new Date(2026, 9, 22, 11, 30);

describe('renderSection', () => {
  it('renders the bullets in order', () => {
    const f = base({
      branches: [
        { name: 'spike-x', merged: false, gone: true },
        { name: 'done', merged: true, gone: false },
      ],
      prs: [pr(21, 'OPEN'), pr(20, 'MERGED', '2026-10-22T08:00:00Z'), pr(19, 'CLOSED', '2026-10-01T08:00:00Z')],
    });
    expect(renderSection(f, { computer: 'PC', at: AT })).toBe(
      [
        '## Git (checked on PC, 2026-10-22 11:30)',
        '',
        '- `main` at 3e21fd9 (2026-10-22): Merge pull request #20',
        '- Open PRs: #21 Title 21 (b21)',
        '- Merged or closed in the last 14 days: #20',
        '- Local branches not merged: spike-x (upstream gone)',
      ].join('\n'),
    );
  });

  it('cuts a list at five entries', () => {
    const prs = Array.from({ length: 7 }, (_, i) => pr(30 + i, 'OPEN'));
    const out = renderSection(base({ prs }), { computer: 'PC', at: AT });
    expect(out).toContain('#34 Title 34 (b34), and 2 more');
    expect(out).not.toContain('#35');
  });

  it('says what could not be checked', () => {
    const out = renderSection(base({ fetched: false, prs: null }), { computer: 'PC', at: AT });
    expect(out).toContain('- Not fetched: the remote could not be reached');
    expect(out).toContain('- No PR facts: gh is not installed or not signed in');
    expect(renderSection(base({ prs: null, github: false }), { computer: 'PC', at: AT })).not.toContain('No PR facts');
  });
});

describe('renderFacts', () => {
  it('stays within 4,000 characters for 20 PRs with long titles', () => {
    const prs = Array.from({ length: 20 }, (_, i) => pr(i + 1, 'OPEN', null, 'x'.repeat(300)));
    expect(renderFacts(base({ prs })).length).toBeLessThanOrEqual(4000);
  });

  it('redacts secrets', () => {
    const out = renderFacts(base({ commits: [{ hash: 'abc1234', date: '2026-10-22', subject: 'rotate AKIAIOSFODNN7EXAMPLE' }] }));
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });
});

describe('factsHash', () => {
  it('is equal for equal facts and differs when a PR changes state', () => {
    expect(factsHash(base({ prs: [pr(1, 'OPEN')] }))).toBe(factsHash(base({ prs: [pr(1, 'OPEN')] })));
    expect(factsHash(base({ prs: [pr(1, 'OPEN')] }))).not.toBe(factsHash(base({ prs: [pr(1, 'MERGED', '2026-10-22T08:00:00Z')] })));
  });
});

describe('quietEnv', () => {
  it('turns off every prompt, Git Credential Manager windows included, and keeps the rest', () => {
    const env = quietEnv({ PATH: '/bin', GCM_INTERACTIVE: 'auto' });
    expect(env).toEqual({ PATH: '/bin', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GH_PROMPT_DISABLED: '1' });
  });
});

describe('quietOptions', () => {
  it('hides the console window and starts commands with prompts off', () => {
    const opts = quietOptions('/repo', 5000);
    expect(opts).toMatchObject({ cwd: '/repo', timeout: 5000, windowsHide: true });
    expect(opts.env).toMatchObject({ GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' });
  });

  it('leaves cwd out when none is given', () => {
    expect('cwd' in quietOptions(undefined, 5000)).toBe(false);
  });
});
