# Git Reality Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** During `hub sync`, check each tracked project's state page against its git checkout and PRs, drop the lines git shows are settled, and end the page with a `## Git` section.

**Architecture:** Core gets optional git inputs on the page build and review (the server passes none). The collector learns each project's checkout path, gathers facts with `git`/`gh` through an injectable runner, and adds projects whose facts changed to the page step.

**Tech Stack:** TypeScript, Node 22, vitest, zod. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-22-context-hub-git-reality-check-design.md`

## Global Constraints

- No server changes. The server's `buildStatePage` call (`apps/server/src/worker.ts`) compiles unchanged.
- Timeouts: git 5 s, `git fetch` 20 s, `gh` 15 s. Env `GIT_TERMINAL_PROMPT=0`, `GH_PROMPT_DISABLED=1`.
- Facts block at most 4,000 characters, put through `stripSecrets`.
- `## Git` section: at most 6 bullets, lists cut with "and N more", "merged or closed" window 14 days, last 15 commits, last 20 PRs.
- A drop based on git cites the id `git` (`GIT_EVIDENCE`).
- Missing git, missing gh, no network: no facts, never a failed sync or lost page.
- No test may run real `git` or `gh` (mocked in `apps/collector/test/setup.ts`, like Claude Code).

## Review Focus

1. **A recorded path that is now a different repo or gone.** Expect it to be removed from `state.repos` and the project skipped. Test in Task 4.
2. **A Claude Code worktree as the session's folder.** Expect the main checkout to be recorded, not the worktree. Test in Task 4.
3. **A page with nothing new and unchanged git facts.** Expect no model call and no save. Test in Task 5.
4. **A `gh` that prints non-JSON or fails.** Expect git facts only (`prs: null`). Test in Task 3.
5. **A page whose old `## Git` section reaches a merge without facts (server fallback).** Expect the old section kept as is, never shown to the model. Test in Task 2.

---

### Task 1: Review accepts git evidence

**Files:**
- Modify: `packages/core/src/page-review.ts`, `packages/core/src/llm.ts`, `packages/core/src/summary-prompts.ts`
- Test: `packages/core/test/page-review.test.ts`, `packages/core/test/summarize.test.ts` (or wherever `PromptedLlm` prompts are tested; grep `reviewState`)

**Interfaces:**
- Produces: `export const GIT_EVIDENCE = 'git'` in `page-review.ts`; `ReviewRequest.git?: { text: string; as_of: string }`.

- [ ] **Step 1: Write failing tests**
  - `applyReview` keeps a drop citing `'git'` when `shown` has `GIT_EVIDENCE`, and ignores it when not.
  - The review prompt (`PromptedLlm.reviewState` with a capturing `ask`) contains `<git as_of="2026-10-22T10:00:00.000Z">` and the facts text when `git` is given, has no `<git` without it, and reads `Session digests, newest first:\n(none)` for an empty digest list.
  - `REVIEW_SYSTEM` mentions `"git"` as the id to cite.
- [ ] **Step 2: Run** `pnpm vitest run packages/core` → the new tests fail.
- [ ] **Step 3: Implement.** Add `GIT_EVIDENCE`. In `reviewState`, put the `<git as_of="…">\n…\n</git>` block after `<page>`, before the digests. Add one sentence to `REVIEW_SYSTEM`: when a `<git>` block is given, a line is also settled or outdated when git shows it on strong evidence only (the PR it names is merged or closed, the branch it names is merged or deleted, a commit subject clearly names that work); cite the id `git`; a loose word match is not enough.
- [ ] **Step 4: Run** `pnpm vitest run packages/core` → pass.
- [ ] **Step 5: Commit** "Let the page review cite git as evidence".

### Task 2: Page build carries the `## Git` section and a git-only review

**Files:**
- Modify: `packages/core/src/summarize.ts`, `packages/core/src/page-review.ts` (section helpers), `packages/core/src/index.ts` (exports if needed)
- Test: `packages/core/test/summarize.test.ts`, `packages/core/test/page-review.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `export const GIT_HEADING = 'Git'`; `splitGitSection(body: string): { body: string; section: string | null }`. The section starts at a line matching `/^## Git\b/` and runs to the end of the body or the next `## `. The rest is returned trimmed of trailing blank lines.
  - `PageInputs.git?: { facts: string; as_of: string; section: string }`
  - `buildStatePage` unchanged signature.

- [ ] **Step 1: Write failing tests** (with `FakeLlm`):
  - `splitGitSection` finds a section at the end and in the middle, and returns `section: null` when there is none.
  - **Merge with git:** the previous page holds an old `## Git` section. Expect `projectState`'s `previous` without it, the review's `page.body` without it, `reviews[0].git` equal to `{ text: facts, as_of }`, and the result ending in the new `section`.
  - **Git-only:** current page, `fresh: []`, `git` given. Expect no `projectState` call, one review with `digests: []`, a result keeping the page minus the review's drops (a drop citing `git` is applied), the new section attached, and `fullRebuild: false`.
  - **No git, nothing fresh:** the page is returned exactly as stored, old section included, with no review (today's behaviour).
  - **No git, merge (server fallback):** the old section is not in `previous` or the review page, and the result ends with the old section unchanged.
- [ ] **Step 2: Run** `pnpm vitest run packages/core` → fail.
- [ ] **Step 3: Implement.**
  - Split the section off `current.body` once, at the top.
  - Use the stripped body everywhere a model sees the page.
  - `reviewPage` takes the optional `git`. When it is given, it adds `GIT_EVIDENCE` to `shown` and passes `git: { text: facts, as_of }`.
  - In the nothing-fresh branch, with `git`, run `reviewPage` on the stripped page with `digests: []`.
  - Attach `git.section` when given, else the old section, as `body + '\n\n' + section`.
- [ ] **Step 4: Run** `pnpm vitest run packages/core apps/server` → pass, with the server suite unchanged.
- [ ] **Step 5: Commit** "Carry a Git section on state pages and review pages against git alone".

### Task 3: Gather and render git facts

**Files:**
- Create: `apps/collector/src/git-facts.ts`
- Modify: `apps/collector/test/setup.ts` (mock `realRunner` to return null)
- Test: `apps/collector/test/git-facts.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type CommandRunner = (cmd: 'git' | 'gh', cwd: string, args: string[], timeoutMs: number) => string | null;
  export const realRunner: CommandRunner; // execFileSync, utf8, stdio ignore/pipe/ignore, env with the two prompt flags; null on any failure or empty output
  export interface Commit { hash: string; date: string; subject: string }
  export interface Pr { number: number; title: string; state: 'OPEN' | 'MERGED' | 'CLOSED'; branch: string; closed_at: string | null }
  export interface RepoFacts {
    fetched: boolean;
    branch: string;                 // e.g. "main"
    commits: Commit[];              // newest first, at most 15; commits[0] is the tip
    branches: { name: string; merged: boolean; gone: boolean }[]; // local, excluding the default branch
    prs: Pr[] | null;               // null: no PR facts
  }
  export function gatherFacts(dir: string, key: string, run: CommandRunner): RepoFacts | null; // null when no default branch is found
  export function renderFacts(f: RepoFacts): string;   // for the model, <= 4,000 chars, stripSecrets applied
  export function factsHash(f: RepoFacts): string;     // sha256 of JSON.stringify(f)
  export function renderSection(f: RepoFacts, o: { computer: string; at: Date }): string; // the "## Git (checked on …, YYYY-MM-DD HH:MM)" markdown, local time
  ```
- Commands, in order:
  1. `git fetch --quiet --prune origin` (20 s); `fetched` is true unless it returned null. A successful quiet fetch prints nothing, so the runner returns `''` there. The runner returns `''` on success with empty output and null only on failure.
  2. Default branch: `git symbolic-ref --short refs/remotes/origin/HEAD` gives `origin/main`. Else try `git rev-parse --verify --quiet origin/main`, `origin/master`, `main`, `master` in order. The ref used for log and merged is the resolved one, and `branch` is its name without `origin/`.
  3. `git log -15 --format=%h%x09%cs%x09%s <ref>`.
  4. `git for-each-ref refs/heads --format=%(refname:short)%x09%(upstream:track)` and `git branch --format=%(refname:short) --merged <ref>`.
  5. Only for keys starting `github.com/`: `gh pr list --state all --limit 20 --json number,title,state,headRefName,mergedAt,closedAt` (15 s). `closed_at` is `mergedAt ?? closedAt`. Bad JSON means `prs: null`.
- Section bullets, in order, skipping empty ones:
  1. `` `<branch>` at <hash> (<date>): <subject> ``
  2. `Open PRs: #N Title (branch), …`
  3. `Merged or closed in the last 14 days: #N, #M, …`
  4. `Local branches not merged: name, name (upstream gone), …`
  5. `Not fetched: the remote could not be reached` when `fetched` is false.
  6. `No PR facts: gh is not installed or not signed in` when `prs` is null for a GitHub key.

  Each list is cut at 5 entries with `and N more`. The heading reads ``## Git (checked on <computer>, <YYYY-MM-DD HH:MM>)``.

- [ ] **Step 1: Write failing tests** with a fake runner keyed on `cmd + ' ' + args.join(' ')`:
  - gathers every field, as above
  - falls back to `origin/master` when there's no `origin/HEAD`
  - returns `null` when no branch resolves
  - a failed fetch gives `fetched: false`
  - gh returning null, or `not json`, gives `prs: null`, and a `local:` key never calls gh
  - `renderSection` output for a fixed `at`: the exact markdown in the spec's example shape, a 14-day cut-off, "and 2 more" at 7 open PRs
  - `renderFacts` stays at or under 4,000 characters for 20 PRs with 300-character titles, and has an `AKIA…` key redacted
  - `factsHash` is equal for equal facts and different when one PR changes state
- [ ] **Step 2: Run** `pnpm vitest run apps/collector/test/git-facts.test.ts` → fail.
- [ ] **Step 3: Implement** in `git-facts.ts`. Add the `realRunner` mock to `setup.ts`, the same way `findClaude` is mocked there.
- [ ] **Step 4: Run** the test file → pass.
- [ ] **Step 5: Commit** "Gather git and PR facts for a project's checkout".

### Task 4: Remember each project's checkout

**Files:**
- Modify: `apps/collector/src/project.ts`, `apps/collector/src/config.ts` (`State`), `apps/collector/src/sync.ts`, `apps/collector/src/cli.ts` (`Io.cwd`, pass `cwd`), `apps/collector/src/bin.ts` (set `cwd: process.cwd()`)
- Test: `apps/collector/test/project.test.ts`, `apps/collector/test/sync.test.ts`

**Interfaces:**
- Produces:
  - `export function checkoutFor(dir: string, deps: ResolveDeps): { path: string; key: string } | null` in `project.ts`. If `dir` doesn't exist, it tries the repo of a `CLAUDE_WORKTREE` path. `path` is the parent of `git rev-parse --path-format=absolute --git-common-dir`, falling back to `--show-toplevel`. `key` is computed as `keyForExistingDir(path)` does. It returns null outside a repo.
  - `State.repos?: Record<string, string>`, `State.git_checked?: Record<string, string>` (project key → facts hash).
  - `SyncOptions.cwd?: string`, `Io.cwd?: string`.
- Recording rules:
  - In `runSync`'s read loop, after `raw` is read for a selected item whose `raw.cwd` is set: `checkoutFor(raw.cwd)`. If its key, after `applyOverrides(key, sessionKey, cfg)` without the assignment (aliases only), equals `projectKey`, set `state.repos[projectKey] = path`.
  - Also for `opts.cwd`, for a tracked key.
  - Not in a dry run.

- [ ] **Step 1: Write failing tests:**
  - `checkoutFor`: a repo folder gives the common-dir parent. A removed `<repo>/.claude/worktrees/x` gives `<repo>`. A non-repo gives null.
  - `sync`: a session with a cwd in a fake repo records `repos[key]`. A session whose repo key differs from its (assigned) project key records nothing. `opts.cwd` inside a tracked repo records it. A dry run records nothing.
- [ ] **Step 2: Run** `pnpm vitest run apps/collector` → fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm vitest run apps/collector` → pass.
- [ ] **Step 5: Commit** "Remember where each project is checked out".

### Task 5: Check pages against git during sync

**Files:**
- Create: `apps/collector/src/git-check.ts`
- Modify: `apps/collector/src/summaries.ts` (`updatePages`), `apps/collector/src/sync.ts`, `apps/collector/src/cli.ts` (`printReport`)
- Test: `apps/collector/test/git-check.test.ts`, `apps/collector/test/summaries.test.ts`, `apps/collector/test/sync.test.ts`, `apps/collector/test/cli.test.ts`

**Interfaces:**
- Consumes: Tasks 2 to 4.
- Produces:
  ```ts
  // git-check.ts
  export interface GitCheck { facts: string; as_of: string; section: string; hash: string }
  export function prepareGitChecks(
    keys: string[], state: State, deps: ResolveDeps & { run: CommandRunner }, o: { now: Date; computer: string },
  ): { checks: Map<string, GitCheck>; skipped: PageLeft[] };
  ```
  For each key, `prepareGitChecks` confirms the recorded path with `checkoutFor`. A missing path, or one that resolves to another key, is deleted from `state.repos` and skipped with "no checkout on this computer". It then calls `gatherFacts`, which gives "git found no default branch" when null.
  - `updatePages(remote, llm, keys, budget, opts)` gains `opts.git?: Map<string, GitCheck>` and `opts.gitOnly?: Set<string>`. It passes `git` into `buildStatePage` and returns `{ updated, left, checked: string[] }`, where `checked` lists the keys saved with facts. A `gitOnly` key whose inputs have no page is skipped without a call.
  - `SyncReport.git: { checked: string[]; skipped: PageLeft[] }`.
  - `SyncOptions.run?: CommandRunner` (default `realRunner`), `SyncOptions.computer?: string` (default `os.hostname()`).
- Sync flow, in the existing pages block (only when `remote && !stopped && !opts.session`, and not in a dry run):
  1. `prepareGitChecks(selected, …)` over the tracked keys selected by `--project`.
  2. `gitOnly` is the keys with a check whose `hash !== state.git_checked?.[key]` and which aren't in `needed`. The keys to update are the `needed` ones not deferred, plus `gitOnly`.
  3. When `llm === null`, `gitOnly` keys are skipped with the existing "Claude Code is not installed" reason, in `report.git.skipped`.
  4. After `updatePages`, set `state.git_checked[key] = hash` for each key in `checked`.
  5. A `gitOnly` key left by `updatePages` goes to `report.git.skipped`, not `report.pages.left`. The hub reads `pages.left` as pages behind.
- CLI: when `report.git.checked.length > 0`, print `Checked against git: <n> project(s)`. When nothing was checked and something was skipped, print `Not checked against git:` and a `  <name>: <reason>` line for each.

- [ ] **Step 1: Write failing tests:**
  - `prepareGitChecks`: a good path gives a check whose section contains `checked on PC`. A recorded path that now resolves to another key is removed and skipped. A missing path is skipped.
  - `updatePages`: with `git` for a key and no fresh digests, there's one review with `git` and a PUT whose body ends with the section, and the key is in `checked`. A `gitOnly` key with no page makes no call and no PUT.
  - `sync` (fake runner, fake llm, existing harness):
    - First run with facts: a review and a PUT, and `git_checked` saved.
    - Second run with the same facts: no review and no PUT.
    - Third run after one PR changes state: a review and a PUT.
    - A run where the page PUT is refused: `git_checked` unchanged, and the key in `report.git.skipped`, not `pages.left`.
    - A dry run: the runner is never called.
  - `cli`: the "Checked against git: 1 project" line.
- [ ] **Step 2: Run** `pnpm vitest run apps/collector` → fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck` → all pass, with 0 type errors.
- [ ] **Step 5: Commit** "Check project pages against git during hub sync".

### Task 6: Docs

**Files:**
- Modify: `README.md`, the part that says a briefing is only as current as the last sync (around line 162). Add one short paragraph: what the check does, that it needs the project checked out on the computer that syncs, that `gh` adds PR facts, and that it runs `git fetch`.

- [ ] **Step 1:** Write the paragraph.
- [ ] **Step 2: Commit** "Document the git check".
