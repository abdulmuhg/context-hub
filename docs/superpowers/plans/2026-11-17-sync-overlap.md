# Sync Overlap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Only one sync writes on a computer at a time. A manual `hub sync` waits for a running one. An auto-sync that finds one running is re-run afterwards instead of being dropped.

**Architecture:** One lock file, `<hubDir>/auto.lock`, now holds an owner token. Every `runSync` that writes takes it (the auto child and a manual non-dry-run sync). A manual sync polls until the lock is free. An auto child that loses the race touches `<hubDir>/auto.rerun`. Whoever holds the lock drains that flag: the auto child loops, and a manual sync spawns the detached auto child after it releases the lock.

**Tech Stack:** TypeScript, Node ≥ 22, vitest, `node:fs`, `node:child_process`.

**Spec:** the architect brief and the decisions in this session (summarized below; there is no separate spec file).

| | |
|---|---|
| Problem | Manual `hub sync` ignores `auto.lock`, so a manual sync and an auto-sync can run at once. Both summarize the same sessions with the user's Claude Code, and the last `state.json` save wins. An auto-sync that finds the lock held exits, and the sessions that ended meanwhile wait for the next trigger. |
| Approach | One shared lock with an owner token. Manual sync waits (15 min timeout). A skipped auto-sync leaves a rerun flag that the holder drains. |
| Why | The server already makes concurrent uploads safe (one transaction per upload, hash checks, versioned pages). The waste and the lateness are on the computer, so the fix belongs in the collector. |
| Risk | A stale lock after Ctrl+C or a crash blocks auto-sync. This is handled by cleanup on interrupt, the owner token, and the existing 10-minute staleness rule. |
| Verify | vitest acceptance tests, then two real `hub sync` processes on Windows against the server in Docker. |

## Global Constraints

- The lock file name stays `auto.lock`. A detached child from an older build must keep excluding a new manual sync during an upgrade.
- `LOCK_MAX_AGE_MS` stays at 10 min and the heartbeat at 60 s.
- Manual wait: poll every 2 s, timeout 15 min.
- Rerun passes per holder: at most 3. When the cap is hit, the flag stays in place.
- `--dry-run` never takes or waits for the lock.
- `runSync` is the only writer of `state.json` (checked with `grep saveState(`), so the lock wraps exactly the two `runSync` call sites in `cli.ts` and `auto.ts`.
- Out of scope: a fully atomic takeover of a stale lock (two processes finding the same stale lock in the same millisecond), and deduplicating sessions by topic.
- No Claude attribution in commits.

## Review Focus

1. **A flag set during the last pass, or between that pass and the release, is not lost.** Expect one more pass, or a spawned child. Tested in Task 3 by `drains a flag that appears after the last pass`.
2. **Ctrl+C during a manual sync removes the lock.** Expect the next auto-sync to start at once, not 10 minutes later. Tested in Task 4 by `interrupt releases the lock`.
3. **A holder's release or heartbeat never touches a lock now owned by someone else** (for example after laptop sleep and a stale takeover). Tested in Task 1 by `release keeps a lock owned by another token` and `heartbeat leaves a foreign lock alone`.
4. **A lock file holding the old format** (a plain ISO date, written by a running older child) is still read correctly for staleness. Tested in Task 1 by `reads an old plain-date lock`.
5. **The wait timeout says plainly that a sync is still running and the user can re-run later.** The output must not look like a crash. Tested in Task 4 by `times out with a clear message`.

---

### Task 0: Lint command (needs your yes: dev-dependency install)

Preflight reports `lint command MISSING`. Proposal: add `@biomejs/biome` as a root dev dependency, add a `"lint": "biome lint ."` script, and add a minimal `biome.json` (recommended rules, ignore `node_modules`, `dist` and `**/fixtures`). Fix or turn off only the rules that fire on the existing code. Bulk rewrites are out of scope.

- [ ] Install, configure, and run `pnpm lint` → exit 0
- [ ] `pnpm test` still passes
- [ ] Commit `Lint: biome with recommended rules`

If you decline the install, skip this task. The ledger will then report lint as not run.

### Task 1: Owned lock module

**Files:**
- Create: `apps/collector/src/lock.ts`
- Modify: `apps/collector/src/auto.ts`. Remove `takeLock` and `startLockHeartbeat` and import them from `lock.ts`. Keep the `auto.ts` re-exports so the existing tests still compile.
- Test: `apps/collector/test/lock.test.ts`. Move the existing lock tests from `auto.test.ts:320+` here.

**Interfaces (produces):**
```ts
export const LOCK_FILE = 'auto.lock';
export const RERUN_FILE = 'auto.rerun';
export interface Held { path: string; token: string }
/** Creates or takes over a stale lock. Content: JSON {"token","at"}. Null when a fresh lock exists. */
export function takeLock(lockPath: string, now: Date, token?: string): Held | null;
/** Rewrites "at" only while the file still carries held.token. */
export function startLockHeartbeat(held: Held, now: () => Date, everyMs?: number): () => void;
/** Unlinks only when the file still carries held.token. */
export function releaseLock(held: Held): void;
```
The default token is `${process.pid}-${randomUUID()}`. Staleness: parse the content as JSON `at`, or else as a plain ISO date (the old format). If neither parses, the lock counts as stale.

- [ ] **Step 1: Write the failing tests.** Move the existing lock tests and adapt them from `true`/`false` to `Held`/`null`. Then add:
  - `release keeps a lock owned by another token`: A takes the lock, B takes it over after 11 min, `releaseLock(A)`, the file still holds B's token
  - `heartbeat leaves a foreign lock alone`: same setup, tick A's heartbeat, the file's `at` is unchanged
  - `reads an old plain-date lock`: the file holds `T0.toISOString()`. `takeLock` at T0+1 min gives null, and at T0+11 min gives a `Held`
- [ ] **Step 2:** `pnpm vitest run apps/collector/test/lock.test.ts` → FAIL (module missing)
- [ ] **Step 3: Implement `lock.ts`.** Update `runAutoChild` to use `Held` and `releaseLock`. Its behavior does not change yet.
- [ ] **Step 4:** `pnpm vitest run apps/collector/test` → PASS
- [ ] **Step 5:** Commit `Collector: the sync lock knows its owner`

### Task 2: An auto child that loses the race leaves a rerun flag

**Files:** Modify `apps/collector/src/auto.ts` (`runAutoChild`). Test: `apps/collector/test/auto.test.ts`.

**Interfaces (produces):** `markRerun(hubDir: string): void` (touches `RERUN_FILE`) and `takeRerun(hubDir: string): boolean` (unlinks it and returns whether it was there), both in `lock.ts`.

- [ ] **Step 1: Write the failing test** `a held lock leaves a rerun flag`: write a fresh lock owned by someone else and run `runAutoChild`. The fake fetch got no requests, `auto.rerun` exists, and the lock is unchanged.
- [ ] **Step 2:** Run it → FAIL
- [ ] **Step 3: Implement.** In `runAutoChild`, when `takeLock` returns null, call `markRerun` and then return.
- [ ] **Step 4:** Run it → PASS
- [ ] **Step 5:** Commit `Auto-sync: a skipped run asks for another pass`

### Task 3: The holder drains the flag

**Files:** Modify `apps/collector/src/auto.ts`. Test: `apps/collector/test/auto.test.ts`.

**Interfaces (produces):** `export const MAX_PASSES = 3;`. `runAutoChild` keeps its signature.

The loop must run in this order:
```
held = takeLock(...) ?? (markRerun; return)
passes = 0
loop:
  takeRerun(hubDir)            // clear BEFORE the pass, so a flag set during the pass survives
  runSync(...); log line; passes++
  if passes < MAX_PASSES and rerun flag exists: continue loop
  break
releaseLock(held)
if passes < MAX_PASSES and rerun flag exists and (held = takeLock(...)): go to loop   // closes the release race
```

- [ ] **Step 1: Write the failing tests:**
  - `drains a flag set during the run`: the fake `runSync` (through the fetch or llm hook) calls `markRerun` on its first pass. Expect exactly 2 log lines, no flag left, and no lock left.
  - `drains a flag that appears after the last pass`: inject a `beforeRelease`-style hook (an optional `onPassEnd` in the test-only options) that marks the flag after the pass. Expect 2 passes.
  - `stops at the pass cap and keeps the flag`: every pass sets the flag. Expect 3 log lines and `auto.rerun` still present.
- [ ] **Step 2:** Run them → FAIL
- [ ] **Step 3: Implement** the loop above. The test hook is an optional field on the options object, and production leaves it unset.
- [ ] **Step 4:** Run them → PASS
- [ ] **Step 5:** Commit `Auto-sync: sessions that end mid-run are synced right after`

### Task 4: Manual sync takes the lock and waits

**Files:** Modify `apps/collector/src/cli.ts`, the sync branch around `:513-525`. Test: `apps/collector/test/cli.test.ts`.

**Interfaces:**
- Consumes `takeLock`, `startLockHeartbeat`, `releaseLock`, `takeRerun` and `RERUN_FILE` from Task 1–2.
- Produces `waitForLock(lockPath: string, opts: { now: () => Date; sleep: (ms: number) => Promise<void>; timeoutMs?: number; pollMs?: number; onWait?: () => void }): Promise<Held | null>` in `lock.ts`. It calls `onWait` once, before the first sleep.
- Adds optional `Io.sleep` for tests. The default is a real `setTimeout` promise.

Behavior for a non-dry-run sync, in the CLI (not inside `runSync`):
1. Call `waitForLock`. If it has to wait, print `Another sync is running on this computer. Waiting for it to finish…` once.
2. On timeout, throw `Fail("A sync is still running on this computer after 15 minutes. Run hub sync again once it finishes; hub auto status shows its last line.")`.
3. Start the heartbeat, and register `io.onInterrupt`, which calls `releaseLock`.
4. Run `runSync` in `try`, and in `finally` stop the heartbeat, call `releaseLock`, and unregister the interrupt handler.
5. After release: if `auto.rerun` exists, spawn the detached `--auto-child`. Use the same spawn call as `values.auto`, extracted into a local `spawnAutoChild(io)`.

- [ ] **Step 1: Write the failing tests:**
  - `waits for a running sync, then runs`: a fresh foreign lock, and a fake `sleep` that releases the foreign lock on its 2nd call. The waiting line is printed exactly once, an upload happened, and no lock is left afterwards.
  - `times out with a clear message`: the lock is never released, and the fake clock advances 2 s per sleep. Expect exit ≠ 0, the message contains `still running` and `hub sync again`, and nothing was uploaded.
  - `dry run never waits`: a fresh foreign lock and `--dry-run`. `sleep` is never called and the report is printed.
  - `interrupt releases the lock`: fire the captured `onInterrupt` handler during `runSync`. `auto.lock` is gone.
  - `hands a pending rerun to the auto child`: a flag exists at the end, so the fake `spawn` was called with `sync --auto-child`.
- [ ] **Step 2:** `pnpm vitest run apps/collector/test/cli.test.ts` → FAIL
- [ ] **Step 3: Implement** `waitForLock` and the CLI wiring.
- [ ] **Step 4:** Run it → PASS
- [ ] **Step 5:** Commit `hub sync: wait for a sync already running on this computer`

### Task 5: Acceptance test, manual and auto at once

**Files:** Test `apps/collector/test/overlap.test.ts`.

- [ ] **Step 1: Write the test** `manual and auto started together summarize each session once`. Use fixture sessions for 3 tracked main sessions and one fake `Llm` shared by both runs that counts `summarize` calls and awaits a short real delay. Start `runCli(['sync'])` and `runAutoChild(...)` with `Promise.all` on the same `hubDir`. Assert:
  - the LLM was called exactly 3 times
  - the fake server got 3 session PUTs in total
  - `state.json` has hashes for all 3
  - no `auto.lock` is left
  - `auto.rerun` is absent, or a pass consumed it
- [ ] **Step 2:** Run it on `origin/main` code (`git stash`). It fails with 6 summaries, which proves the test catches the bug. Note the output for the ledger.
- [ ] **Step 3:** Run it on the branch → PASS. Then run `pnpm test` and `pnpm typecheck` → all green.
- [ ] **Step 4:** Commit `Test: overlapping syncs do the work once`

### Task 6: Real check on Windows (no commit)

- [ ] Run `docker compose` with the server from the repo root's dev setup on localhost, with no `ANTHROPIC_API_KEY`.
- [ ] Set up a temp `HOME` with 3 fixture Claude Code sessions and a temp hubDir, and connect with a device code from the local dashboard.
- [ ] Start a long `hub sync` (slowed down by many fixture sessions) and, 1 s later, a second `hub sync` in another terminal. Capture the waiting line from the second.
- [ ] Run `hub sync --auto-child` while the lock is held. `auto.rerun` appears, and after the holder finishes, `auto.log` gains the extra pass line.
- [ ] Ctrl+C a manual sync, then check that `auto.lock` is gone.
- [ ] Put the evidence (output lines) in the ledger.
