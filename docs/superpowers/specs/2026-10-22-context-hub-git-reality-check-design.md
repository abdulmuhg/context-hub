# context-hub — checking state pages against git

Date: 2026-10-22. Builds on the local-summaries design
(`2026-10-21-context-hub-local-summaries-design.md`), which moved state pages
onto the owner's computer, and on the page review in
`packages/core/src/page-review.ts`. The idea was sketched in session
`claude-code:462bf428-452e-4244-977f-2636e9108fee` (2026-10-21). The owner
skipped the questions and asked for it to be built, so every point below is
**my call** unless it repeats that sketch.

## Why

A state page records what sessions said. It misses anything done outside a
conversation: a PR merged on the website, a branch deleted, a commit pushed
from another tool. The page then keeps saying "PR #17 is open" for days. The
MCP instructions already warn about this, and `/hub-catchup` checks git live,
but claude.ai and the phone can't check anything. To them the page is all
there is. Stale pages are the hub's main trust problem.

`hub sync` already runs on the computer that has the repo, and the page
review already drops settled lines. This design gives that review a second
kind of evidence, git, and adds a short section to the page that says what
git showed and when.

## Goals

- During `hub sync`, for each tracked project with a checkout on this
  computer, gather a small, fixed set of git facts (and PR facts when `gh`
  works).
- The page review drops open items and current-state lines that git shows
  are settled or outdated, as it already does for sessions.
- This works even when no new session arrived: a PR merged on the website
  shows up on the next sync.
- The page ends with a short `## Git` section, written from the facts
  without a model, that says which computer checked and when.

## Non-goals

- Server changes. The hub stores the page as it does today; it holds no
  GitHub token and runs no git.
- Rewriting lines. The review still only drops lines and rewrites the
  summary. The `## Git` section carries the new facts.
- Checks at read time (in `get_project`).
- Projects with no checkout on this computer, including `local:` projects
  whose folder is gone. They are skipped and keep their last `## Git`
  section.

## Anti-goals (a failure even if it works)

- **Dropping a real open item on weak evidence.** Only strong evidence
  counts: the PR the line names is merged or closed, the branch it names is
  merged or deleted, or a commit subject clearly names that work. A loose
  word match is not enough. A stale line is noise; a wrong drop loses
  information.
- **`hub sync` hanging or getting slow.** Every git and gh call has a
  timeout. No network, no `gh` or no git means no facts, never a failed
  sync or a lost page.
- **Spending real plan usage.** A check with no new sessions sends the page
  and the facts only, not the digests. It runs only when the facts changed
  since the last check.

## Decided

### 1. Where it runs

Only in the collector, during `hub sync`. Core gets **optional** fields
(`PageInputs.git`, `ReviewRequest.git`). The server's fallback in
`apps/server/src/worker.ts` passes none and behaves as today, apart from
carrying the `## Git` section over (section 6).

### 2. Finding the checkout for a project

Nothing maps a project key to a folder today: `project.ts` only resolves
folder to key. The collector state (`state.json`) gets a new map:

```ts
/** The main checkout of each project on this computer, by project key. */
repos?: Record<string, string>;
```

It is filled in two places:

- **In `scan`**, when a session file is parsed (`raw` is set) and its
  `cwd` exists, is inside a git repo, and that repo resolves to the
  session's project key, after aliases. A session filed by a manual
  assignment never records a path.
- **From the folder `hub sync` runs in**, with the same check, when the
  folder resolves to a tracked key. `/hub-sync` and the session-end hook
  both run inside the repo.

The recorded path is the **main checkout**: the parent of
`git rev-parse --path-format=absolute --git-common-dir`. A Claude Code
worktree under `.claude/worktrees/` is removed when it's done, so it must
not become the project's path. A newer parse overwrites an older path.

Before each check the path is confirmed again: it must exist and still
resolve to the key. If not, it is removed from `repos` and the project is
skipped as "no checkout on this computer".

There is no backfill: an existing user's unchanged sessions aren't parsed.
A project gets its path with its next new session, or the next sync run
from inside it.

### 3. The facts

Gathered in the checkout with read-only commands, except the fetch.
`GIT_TERMINAL_PROMPT=0` and `GH_PROMPT_DISABLED=1` stop any credential
prompt:

1. `git fetch --quiet --prune origin` with a 20 s timeout. Failure is
   ignored and the facts say "not fetched". The fetch only updates
   remote-tracking refs; `/hub-catchup` already does the same.
2. The default branch: `refs/remotes/origin/HEAD`, else `origin/main` or
   `origin/master` if it exists, else the local `main` or `master`.
3. Its tip: short hash, date, subject.
4. Its last 15 commits: short hash, date, subject.
5. Local branches: whether each is merged into the default branch, and
   whether its upstream is gone (`%(upstream:track)` = `[gone]`).
6. If `gh` is installed and signed in: `gh pr list --state all --limit 20
   --json number,title,state,headRefName,mergedAt,closedAt`, with a 15 s
   timeout. Absence and failure both mean "no PR facts". Projects whose key
   is not a GitHub remote skip this step.

They are rendered as a plain text block of at most 4,000 characters and put
through `stripSecrets` like everything else that leaves the computer. Git
calls use a 5 s timeout, like `realGit`. Fetch and gh need the longer ones
above.

### 4. The review uses them

`ReviewRequest` gets `git?: { text: string; as_of: string }`. The prompt
adds a `<git as_of="…">` block and one rule: an open item is also settled,
and a current-state line also outdated, when git shows it, on the strong
evidence named in the anti-goals. Such a drop cites the id `git`.

`page-review.ts` exports `GIT_EVIDENCE = 'git'`. The caller adds it to the
`shown` set only when facts were sent, so `applyReview` keeps its rule that
a drop must cite evidence the model was actually shown.

### 5. When it runs

- **A page that is being written anyway** (the hub lists it in
  `pages_needed`): the facts go into its review, which runs as today.
- **A page with nothing new**: the collector hashes the facts, leaving out
  the check time, and compares the hash with `state.git_checked[key]`. If
  they differ and the project has a page, it runs a **git-only review**: the
  page and the facts, with no digests. It then saves the result with the
  page's current `through` and version. The server already accepts that.
- After a page is saved, `state.git_checked[key]` gets the new hash. A
  failed or refused save leaves it unchanged, so the next sync tries again.
- A git-only review is one small model call. It doesn't count against the
  summary cap. A usage limit stops it like any page work and records the
  page as left, with the reason.
- `--dry-run` gathers nothing and calls nothing. `--session` runs skip
  pages, as they already do. `--project` limits the check like it limits
  pages.

### 6. The `## Git` section

The collector appends this to the page body, after "Latest sessions",
written from the facts without a model:

```markdown
## Git (checked on PC, 2026-10-22 11:30)

- main at 3e21fd9 (2026-10-22): Merge pull request #20 from abdulmuhg/lean-get-project
- Open PRs: #21 Add the git check (git-reality-check)
- Merged or closed in the last 14 days: #20, #19, #18
- Local branches not merged: spike-x (upstream gone)
```

It has at most 6 bullets, and a list is cut with "and N more". "Checked on"
names this computer: the name given at `hub login` if the collector keeps
it, else the host name. The date is local time, like the CLI's other times.

The models never see this section. Core strips it from the `previous` page
before a merge or rebuild, and from the page shown to the review. After the
page is built it is attached again:

- If this build had facts, a new section is attached.
- If it had none (the server fallback, no checkout, git missing), the
  previous section is kept as it was, with its old date. That is still
  true as of that date.

Because it is attached after the length check, it doesn't count toward
`STATE_HARD_WORDS`. The server scrubs it like the rest of the body.

### 7. What the owner sees

The `hub sync` report gets `git: { checked: string[]; skipped: { project,
reason }[] }`. The CLI prints one line, for example "Checked against git: 2
projects (1 page updated)", and names skipped projects only with `-v` or
when nothing could be checked. The hub's run report and dashboard are
unchanged.

## Constraints

- Windows and macOS. Node 22. `git` may be missing (then skip), and so may
  `gh` (then git only).
- Uses the existing `GitRunner` pattern, with a second runner for `gh`, so
  tests pass fakes. No new dependencies.
- Pages stay under the existing prompt limits. The facts block adds at most
  about 2,000 tokens to a review.

## Left to the builder

- Whether the fetch and gh runners take a timeout option or are separate
  functions.
- The exact wording of the prompt rule, the facts block and the CLI line.
- How to store the computer name if the collector doesn't keep it yet.
