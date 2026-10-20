# context-hub One-Command Sync — Implementation Plan

> **For agentic workers:** Implement task by task in order. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `hub sync` is the only command a user needs day to day, and `hub auto on` optionally makes even that automatic for Claude Code.

**Architecture:** All changes are in the collector (`apps/collector`). `hub sync` gains a prompt for new, untracked projects (remembered per project) and a one-line summary. `hub auto on|off|status` adds or removes a Claude Code `SessionEnd` hook that runs `hub sync --auto`, which starts a detached background sync and returns at once. No server changes.

**Tech Stack:** TypeScript (NodeNext ESM), Node 22 built-ins, vitest. No new dependencies.

## Design (agreed with the owner)

**Part A — one command.**
- When `hub sync` runs in a terminal, it first looks for projects that have sessions on this computer but are neither tracked nor previously declined, and asks about each: `New project "<name>" (<n> sessions). Upload it to the hub? [y/N] `. `y` tracks it; anything else (including Enter) declines it, and the answer is remembered. Then it syncs as today.
- When `hub sync` is not in a terminal (the `/hub-sync` slash command, the auto hook, scripts), it never asks. It prints one line when there are new projects: `<n> new project(s) not uploaded: <names>. Run hub sync in a terminal to choose.`
- It never asks with `--dry-run`, `--project`, `--session` or `--auto`.
- `hub sync` ends with one summary line (below).
- `hub track <p>` still works and removes `<p>` from the declined list; `hub untrack <p>` adds it to the declined list, so it is not asked about again.
- The usage text puts `login`, `sync` and `auto` first and moves everything else under "Advanced". No command is removed.
- `/hub-sync` always runs plain `hub sync` (all tracked projects).

**Part B — no command (opt-in).**
- `hub auto on` adds a `SessionEnd` hook to `~/.claude/settings.json` that runs `hub sync --auto`. `hub auto off` removes it. `hub auto status` says whether it is on and shows the last line of the auto log.
- `hub sync --auto` starts a detached child process that does the sync, and exits immediately with status 0, so closing Claude Code is never delayed. The child: uploads tracked projects only (never asks, never tracks anything new), takes a lock so two runs never overlap, and appends one line per run to `~/.context-hub/auto.log`.
- Off by default. Codex and Antigravity have no such hook; they keep using `hub sync` (documented).

**Why this is safe:** the privacy rule is unchanged: only explicitly tracked projects are ever uploaded, and only a "y" in a terminal tracks a project. Automatic runs skip the moment of review, which is why they are opt-in; secrets are still stripped twice and `hub forget` still deletes anything.

## Global Constraints

- Config gains `declined: string[]` (project keys), default `[]`; older config files without it load as `[]`. It must not change the settings fingerprint (`settingsFingerprint` in `config.ts`): declining changes nothing that is uploaded.
- Exact texts:
  - Prompt: `New project "<name>" (<n> session|sessions). Upload it to the hub? [y/N] ` where `<name>` is the last path segment of the key (as on the dashboard) followed by ` — <key>` when they differ, for example `New project "jsonroom — github.com/abdulmuhg/jsonroom" (3 sessions).`
  - Non-interactive line: `<n> new project(s) not uploaded: <name>, <name>. Run hub sync in a terminal to choose.` (at most 5 names, then `, and <k> more`).
  - Summary, success: `Up to date: <u> uploaded, <c> unchanged, <t> tracked project(s).`
  - Summary with errors: the existing error lines, then `Sync finished with <e> error(s).`
- "Sessions" counts main sessions only (not subagent transcripts), as `hub projects` does.
- The `unfiled` project is never offered.
- Interactive means `process.stdin.isTTY && process.stdout.isTTY`; tests inject it through `Io.interactive?: boolean` (default false when absent).
- Hook entry written by `hub auto on`, as one element of `hooks.SessionEnd`:
  `{ "hooks": [ { "type": "command", "command": "\"<node>\" \"<bundle>\" sync --auto", "timeout": 10 } ] }`
  where `<node>` is `process.execPath` and `<bundle>` is the running `hub` script's absolute path (`process.argv[1]` resolved). Absolute paths, because a hook's `PATH` may not include `~/.local/bin`. Verify this shape against the Claude Code hooks documentation (https://code.claude.com/docs/en/hooks) before implementing, and log any difference as a deviation.
- `~/.claude/settings.json` handling: if it does not exist, create it with only the hook; if it is not valid JSON, refuse with `~/.claude/settings.json is not valid JSON, so it was not changed. Fix it or add the hook by hand: <command>` and exit 1; otherwise keep every other key and hook untouched, write a backup `settings.json.hub-backup` first, and write atomically (temp file then rename). `on` twice adds nothing new; `off` removes only entries whose command ends with ` sync --auto` and contains the bundle path's file name.
- Auto log: `~/.context-hub/auto.log`, one line per run: `<ISO time> <ok|error> <u> uploaded, <c> unchanged[, <e> errors: <first error>]`; keep the last 200 lines. Lock: `~/.context-hub/auto.lock` holding the child's start time; a lock younger than 10 minutes makes a new run exit quietly, an older one is taken over.
- The auto child never writes to the terminal (stdio ignored) and never throws past its top level; any failure becomes an `error` log line.
- Commits carry no Co-Authored-By or other attribution trailers. No new dependencies. All existing tests keep passing.

## Review Focus

1. **Nothing new is uploaded without a "y" in a terminal:** non-interactive `hub sync`, `/hub-sync` and `--auto` with a new untracked project upload nothing from it. Test in Tasks 1 and 3.
2. **A declined project stays quiet:** declined once, it is not asked about on the next sync, and `hub track` brings it back. Test in Task 1.
3. **Someone's existing `~/.claude/settings.json` survives:** other settings and other hooks (including other `SessionEnd` hooks) are untouched by `on` and `off`; invalid JSON is never overwritten. Test in Task 3.
4. **Closing Claude Code is never delayed:** `hub sync --auto` returns within a second even when the server is unreachable; the work happens in the detached child. Test in Task 3.
5. **Two sessions ending together** do not run two overlapping syncs. Test in Task 3.

---

### Task 1: `hub sync` asks about new projects

**Files:** Modify `apps/collector/src/config.ts`, `apps/collector/src/cli.ts`, `apps/collector/src/bin.ts` (set `interactive`). Test: extend `apps/collector/test/cli.test.ts`, `apps/collector/test/config.test.ts`.

**Interfaces:**
- Produces: `Config.declined: string[]`; `Io.interactive?: boolean`; `newProjects(rows: ProjectRow[], cfg: Config): ProjectRow[]` (exported from `cli.ts` or a small new module) returning rows that are not tracked, not declined, not `unfiled`, with at least one main session.

- [ ] **Step 1: Tests:** interactive sync with one new project and answer `y` tracks it and uploads its sessions; answer Enter declines it (saved in `declined`), uploads nothing from it, and the next interactive sync does not ask again (Review Focus 2); `hub track` on a declined project removes it from `declined`; `hub untrack` adds to `declined`; non-interactive sync with a new project prints the not-uploaded line and uploads nothing from it (Review Focus 1); `--dry-run`, `--project` and `--session` never ask; a config file without `declined` loads; the fingerprint is the same before and after declining a project.
- [ ] **Step 2: Implement.** Ask before the upload, using `listProjects`-style data from the same scan.
- [ ] **Step 3:** `pnpm test` and `pnpm typecheck` pass. **Commit** `git commit -m "Ask about new projects in hub sync and remember the answer"`

### Task 2: The summary line, the usage text and `/hub-sync`

**Files:** Modify `apps/collector/src/cli.ts`, `apps/collector/src/commands.ts`, `integrations/claude-code/hub-sync.md`, `README.md`. Test: extend `apps/collector/test/cli.test.ts`.

- [ ] **Step 1: Tests:** a successful sync ends with the exact summary line; a sync with errors ends with `Sync finished with <e> error(s).`; the usage text lists `login`, `sync` and `auto` before a line `Advanced:` and every existing command after it; `SLASH_COMMANDS['hub-sync.md']` runs `hub sync` with no project argument (the existing test that compares it with the integrations file must still pass).
- [ ] **Step 2: Implement.** New `hub-sync.md` text: run `hub sync`; report the summary line and any not-uploaded line in two or three lines; leave out "Personal data:" and "Warning:" lines; on an error, show it exactly and stop. Update the README's "Choose projects and sync" section: day to day, `hub sync` is all you need; it asks about new projects; the other commands are under "Advanced".
- [ ] **Step 3:** `pnpm test` and `pnpm typecheck` pass. **Commit** `git commit -m "End hub sync with a summary, simplify the usage text and /hub-sync"`

### Task 3: `hub auto` and `hub sync --auto`

**Files:** Create `apps/collector/src/auto.ts`; modify `apps/collector/src/cli.ts`. Test: create `apps/collector/test/auto.test.ts`.

**Interfaces:**
- Produces: `autoOn(settingsPath: string, command: string): { changed: boolean }`, `autoOff(settingsPath: string, bundleName: string): { removed: number }`, `autoStatus(settingsPath: string, logPath: string): { on: boolean; lastLine: string | null }`, `hookCommand(nodePath: string, bundlePath: string): string`, `runAutoChild(opts): Promise<void>` (lock, sync tracked only, log), and in `cli.ts`: `hub auto on|off|status`, `hub sync --auto` (spawns `process.execPath` with the bundle and `sync --auto-child`, `detached: true`, `stdio: 'ignore'`, then `unref()` and return 0), `hub sync --auto-child` (calls `runAutoChild`, never prints).

- [ ] **Step 1: Tests:** `autoOn` on a missing file creates it with only the hook; on a file with other keys and another `SessionEnd` hook keeps both and adds ours once, twice in a row still once, and leaves a `.hub-backup` (Review Focus 3); on invalid JSON throws and leaves the file byte-identical; `autoOff` removes only ours; `autoStatus` reports on/off and the last log line; `hookCommand` quotes paths with spaces; `runAutoChild` with a new untracked project uploads nothing from it (Review Focus 1), with a fresh lock exits without syncing, with a stale lock (11 minutes) runs, appends exactly one log line, and keeps only the last 200 lines; `hub sync --auto` with a fake spawn returns 0 at once and spawns the child with `detached: true` and ignored stdio (Review Focus 4); a real spawn test (skipped on Windows) runs `hub sync --auto` against an unreachable server and returns in under 1 second.
- [ ] **Step 2: Implement.**
- [ ] **Step 3:** `pnpm test` and `pnpm typecheck` pass. **Commit** `git commit -m "Add hub auto: sync automatically when a Claude Code session ends"`

### Task 4: Docs

**Files:** Modify `README.md`.

- [ ] **Step 1:** In "Choose projects and sync", add "Sync automatically (Claude Code)": `hub auto on`, what it does (a background sync of tracked projects when a session ends, never tracks new projects, logs to `~/.context-hub/auto.log`), `hub auto off`, `hub auto status`, and that Codex and Antigravity still need `hub sync`.
- [ ] **Step 2: Commit** `git commit -m "Document hub auto"`. Do not push.
