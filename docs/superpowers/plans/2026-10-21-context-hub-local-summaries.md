# Local Summaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `hub sync` writes session digests and state pages with Claude Code on the owner's computer (their Claude plan), and the server needs no `ANTHROPIC_API_KEY`; the key becomes an optional fallback.

**Architecture:** The prompts, schemas and digest/page logic move from `apps/server` into `packages/core` behind one abstract `PromptedLlm`, so the server's `AnthropicLlm` and the collector's new `ClaudeCodeLlm` (which runs `claude -p`) produce the same output. The collector summarizes before it uploads and sends session and digest in one request; state pages are built on the computer from inputs the server hands out, and saved with a version check. The server worker only handles sessions that arrive without a digest.

**Tech Stack:** Node ≥ 22, TypeScript, pnpm workspaces, `better-sqlite3`, `zod/v4`, vitest, Claude Code CLI 2.1.296.

**Spec:** `docs/superpowers/specs/2026-10-21-context-hub-local-summaries-design.md`. Read it first; decision numbers below refer to it.

## Global Constraints

- Default model `claude-sonnet-5-5` (full ID, never the alias), effort `low`; both per-computer settings in `~/.context-hub/config.json`.
- `claude` is started **without a shell**, with every environment variable whose name starts with `ANTHROPIC_` or `CLAUDE` removed, and with exactly these flags: `-p --model <id> --effort <level> --output-format json --json-schema <schema> --system-prompt <prompt> --tools "" --no-session-persistence --safe-mode --strict-mcp-config`. The transcript goes on stdin. Never `--bare`.
- At most **20** new digests per sync (a session split into parts counts as one), newest first; `--all` lifts the cap. State pages do not count toward the cap (my call, spec decision 12 left it open).
- A main session uploads only with its digest, except: empty sessions (fixed digest, no model call), refusals (`refused`), 3 failed syncs in a row on the same content (`failed`), and re-cleaned sessions already on the hub (`summary_to_follow`).
- A refused page save is retried at most **2** times per sync.
- The server's key is never spent on a page or session a computer owns (spec anti-goals).
- Older collectors (no `digest` field on upload) must keep working: their main sessions become `pending` as today.
- Match the surrounding code: comment density, naming, `Fail`/`HttpError` usage, small focused files.

## Deviation from the spec (record it in the deviations log, Task 13)

Spec decision 12 reuses `dirty` to mean "page behind". That would turn every page update into a full rebuild (`dirty` forces one today). Instead: `dirty` keeps its meaning (needs a full rebuild: moves, deletes, re-cleaning), and "behind" is computed: a project's page is behind when it has an `ok` digest whose `saved_seq` is greater than the page's `digests_through`. Assistants still see `stale` only for `dirty`.

## Review Focus

1. **Arguments with quotes and newlines on Windows** (the system prompt and JSON schema). Expected: they reach `claude` byte for byte. Test in Task 8 (`passes the prompt and schema as single argv entries`).
2. **The usage limit is hit on part 2 of a split session.** Expected: no partial digest is uploaded, the session waits, and no further model call is made in this run. Test in Task 9 (`stops summarizing when the limit is hit mid-session`).
3. **The hub is unreachable after a digest was written.** Expected: the sync stops making model calls at once, so it doesn't spend plan usage it can't deliver. Test in Task 9 (`makes no more model calls after an upload fails`).
4. **Two computers update the same page.** Expected: the second save gets 409, the page is rebuilt from fresh inputs, and after 2 refusals it is left for a later sync without error. Test in Task 10 (`retries a refused page save twice, then leaves it`).
5. **Auto-sync inherits a Claude session's environment** (`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_SIMPLE`). Expected: all are removed, and `PATH`, `HOME`, `USERPROFILE` and `APPDATA` survive. Test in Task 8 (`cleanEnv drops ANTHROPIC_ and CLAUDE variables only`).

---

### Task 1: Confirm `claude -p` works on the plan (gate)

**Files:** none (manual check; record the result in the PR description).

- [ ] **Step 1: Run one summary call from an ordinary terminal** (not inside a Claude Code session or the desktop app; its sandbox blocks direct connections). If you are running inside one, ask the owner to run it and paste the output.

```bash
echo '[1] USER: Let us use SQLite for the hub.' | env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL -u CLAUDE_CODE_SIMPLE claude -p --model claude-sonnet-5-5 --effort low --output-format json --json-schema '{"type":"object","properties":{"goal":{"type":"string"}},"required":["goal"]}' --system-prompt "State the goal of this transcript." --tools "" --no-session-persistence --safe-mode --strict-mcp-config
```

Expected: JSON with `"is_error":false`, a `structured_output` object containing `goal`, and `modelUsage` keyed by `claude-sonnet-5-5`.

- [ ] **Step 2: Check no session was saved.** List files under `~/.claude/projects` modified in the last minute. Expected: none created by this run.
- [ ] **Step 3: If either check fails, stop.** Report the output to the owner before any further task.
- [ ] **Step 4: Save one failure fixture.** If the owner can provide the JSON from a "usage limit reached" response, save it as `apps/collector/test/fixtures/claude-usage-limit.json`. Otherwise Task 8 uses a hand-written fixture marked as a guess.

### Task 2: Move shared summary code into core

A pure refactor: no behavior change, and every existing test stays green.

**Files:**
- Create: `packages/core/src/summary-schema.ts`, `packages/core/src/summary-prompts.ts`, `packages/core/src/transcript.ts`, `packages/core/src/page-review.ts`, `packages/core/src/llm.ts`
- Modify: `packages/core/src/index.ts`, `packages/core/package.json` (add `"zod"` dependency, same version as `apps/server/package.json`)
- Modify: `apps/server/src/llm-anthropic.ts`, `apps/server/src/llm.ts` (becomes re-exports or is deleted, your choice; update imports), `apps/server/src/transcript.ts`, `apps/server/src/page-review.ts`, `apps/server/src/digest-store.ts` (import `DigestBody` and `DigestItem` from core)
- Move tests: `apps/server/test/transcript.test.ts` and `page-review.test.ts` → `packages/core/test/`

**Interfaces:**
- Produces (all exported from `@context-hub/core`):
  - `summary-schema.ts`: `DigestItem`, `DigestBody`, `DigestSchema`, `StateSchema`, `StatePage`, `ReviewSchema`, and `jsonSchemaOf(schema: z.ZodType): Record<string, unknown>` (via `z.toJSONSchema`). Also `UploadDigest = { body: DigestBody; model: string } | { refused: string; model: string } | { failed: string } | { summary_to_follow: true }`.
  - `transcript.ts`: `TOOL_FIELD_CAP`, `renderLines`, `splitParts`, `renderDigest` (moved unchanged).
  - `page-review.ts`: everything now in `apps/server/src/page-review.ts` (moved unchanged).
  - `summary-prompts.ts`: `DIGEST_SYSTEM`, `MERGE_SYSTEM`, `STATE_SYSTEM`, `REVIEW_SYSTEM` (moved verbatim), `STATE_HARD_WORDS`, `wordCount`, `cutToSections`.
  - `llm.ts`: `LlmRefusal`, `DigestRequest`, `StateRequest`, `ReviewRequest`, `Llm`, `Effort` (moved from `llm-anthropic.ts`), `UsageKind = 'digest' | 'merge' | 'state' | 'shorten' | 'review'` (moved from `apps/server/src/usage.ts`, which now imports it), `AskCall = { system: string; user: string; schema: z.ZodType; kind: UsageKind; project: string | null }`, and `abstract class PromptedLlm implements Llm { abstract readonly model: string; protected abstract ask<T>(call: AskCall): Promise<T> }`. Its `digest`, `mergeDigests`, `projectState` (including the shorten-once-then-cut rule) and `reviewState` hold the user-message building now in `AnthropicLlm`, unchanged.
- `AnthropicLlm extends PromptedLlm` and keeps only its constructor, usage recording, refusal and incomplete-answer handling, inside `ask`.

- [ ] **Step 1: Move the files and the tests; make `AnthropicLlm` extend `PromptedLlm`.**
- [ ] **Step 2: Run the whole suite.** Run: `pnpm test && pnpm typecheck`. Expected: same pass count as before the move, no type errors.
- [ ] **Step 3: Commit** with message `Move summary prompts, schemas and transcript code into core`.

### Task 3: Shared digest and page logic in core

**Files:**
- Create: `packages/core/src/summarize.ts`, `packages/core/test/summarize.test.ts`, `packages/core/test/fake-llm.ts` (move `FakeLlm` from `apps/server/test/helpers.ts` here; the server helpers re-export it)
- Modify: `apps/server/src/worker.ts` (use the core functions; delete its private copies)

**Interfaces:**
- Produces:
  - `CHARS_PER_TOKEN = 2`, `DEFAULT_MAX_INPUT_TOKENS = 60000`, `REBUILD_AFTER_MS = 7 * 24 * 60 * 60_000` (moved from `worker.ts`), `EMPTY_DIGEST: DigestBody` (the "Empty session" body).
  - `writeDigest(llm: Llm, s: { project: string; title: string; messages: Message[] }, maxChars: number): Promise<DigestBody>`: the split, digest-each and merge logic from `worker.ts`'s `writeDigest`, returning `EMPTY_DIGEST` with no call for an empty session.
  - `PageDigest = { session_id: string; title: string; date: string | null; text: string }`
  - `PageInputs = { project: string; page: { summary: string; body: string; rebuilt_at: string; dirty: boolean } | null; digests: PageDigest[] /* every ok digest, oldest first */; fresh: PageDigest[] /* not yet on the page */; now: string; maxChars: number; forceRebuild?: boolean }`
  - `buildStatePage(llm: Llm, inputs: PageInputs): Promise<{ page: StatePage; fullRebuild: boolean } | null>`: returns `null` when `digests` is empty (the caller deletes the page). It rebuilds when there is no page, `dirty`, `rebuilt_at` older than `REBUILD_AFTER_MS`, or `forceRebuild`, using the same newest-first selection under `maxChars` and the previous page when truncated. Otherwise it merges `fresh` into the page. It always finishes with the review pass, which keeps the page if the review fails.
- The worker builds `PageInputs` from the DB, with `fresh = [the digest it just wrote]`, so its behavior is unchanged.
- A merge can now carry several fresh digests. Change the merge task line in `PromptedLlm.projectState` from "the new session digest below" to "the new session digests below". No other prompt changes.

- [ ] **Step 1: Write failing tests** in `summarize.test.ts`:
  - `writeDigest returns EMPTY_DIGEST without a call for an empty session`, which asserts `llm.calls.length === 0`.
  - `writeDigest splits above maxChars and merges the parts`, which asserts calls of kind `digest, digest, merge`.
  - `buildStatePage rebuilds when there is no page`: `fullRebuild === true`, and the state request has `mode === 'rebuild'`.
  - `buildStatePage merges only fresh digests into a current page`: `mode === 'merge'`, and `req.digests` equals `fresh`.
  - `buildStatePage rebuilds a dirty page and a page older than 7 days` (two cases).
  - `buildStatePage returns null when there are no digests`.
  - `buildStatePage keeps the page when the review throws`.
- [ ] **Step 2: Run** `pnpm vitest run packages/core/test/summarize.test.ts`. Expected: FAIL, because `summarize.js` doesn't exist yet.
- [ ] **Step 3: Implement `summarize.ts`; switch `worker.ts` to it.**
- [ ] **Step 4: Run** `pnpm test`. Expected: all pass, including the unchanged `apps/server/test/worker.test.ts`.
- [ ] **Step 5: Commit** with message `Share digest and state-page logic between server and collector`.

### Task 4: Server schema and store for computer-written summaries

**Files:**
- Modify: `apps/server/src/db.ts` (one new migration appended to `MIGRATIONS`), `apps/server/src/digest-store.ts`, `apps/server/src/worker.ts`
- Test: `apps/server/test/digest-store.test.ts`, `apps/server/test/worker.test.ts`, `apps/server/test/db.test.ts`

**Migration (exact columns):**
```sql
ALTER TABLE digests ADD COLUMN written_by TEXT;             -- the computer's token label; NULL = the server
ALTER TABLE digests ADD COLUMN summary_to_follow INTEGER NOT NULL DEFAULT 0;
ALTER TABLE digests ADD COLUMN saved_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE project_states ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE project_states ADD COLUMN digests_through INTEGER NOT NULL DEFAULT 0;
ALTER TABLE project_states ADD COLUMN written_by TEXT;
-- Pages the server owes because it wrote a fallback digest for the project.
CREATE TABLE server_page_queue (project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE);
```
Existing digests get `saved_seq` 0, and existing pages `digests_through` 0, so nothing counts as behind after the upgrade.

**Interfaces:**
- Produces in `digest-store.ts`:
  - `saveDigest(db, args)` gains `writtenBy: string | null`. It sets `saved_seq = (SELECT COALESCE(MAX(saved_seq), 0) + 1 FROM digests)`, `summary_to_follow = 0`, `written_by`.
  - `saveComputerOutcome(db, sessionRowId: number, hash: string, outcome: UploadDigest, writtenBy: string, now: string): boolean`: `body` → `saveDigest`; `refused` → status `refused`; `failed` → status `failed` with `next_attempt_at = NULL` (the fallback never retries it); `summary_to_follow` → `markSummaryToFollow`. Returns false when the stored hash differs.
  - `markSummaryToFollow(db, sessionRowId: number, now: string): void`: status `pending`, `body`/`text` NULL, removes the `digest` search entry, `summary_to_follow = 1`, and marks the project dirty.
  - `markStateDirty` now also does `version = version + 1`.
  - `getProjectState` returns `version`, `digests_through` and `written_by` as well.
  - `savePageIfVersion(db, projectId: number, page: { summary: string; body: string; model: string }, opts: { baseVersion: number | null; through: number; fullRebuild: boolean; writtenBy: string | null; now: string }): { ok: true; version: number } | { ok: false; version: number | null }`. `baseVersion: null` means "there was no page". On success it bumps `version`, sets `digests_through = opts.through` and `written_by`, and clears `dirty` only when `fullRebuild`.
  - `projectsNeedingPage(db: Db): string[]`: project keys where the page is dirty, behind, or missing while the project has `ok` main digests.
  - `nextDueDigest` and `projectHasDueDigest` also require `d.summary_to_follow = 0`.
- Worker changes: the server's own `saveDigest` passes `writtenBy: null`. Where it now calls `markStateDirty` because more digests are queued, it instead inserts the project into `server_page_queue`. The state pass reads `server_page_queue` (respecting `state_retries`) instead of `nextProjectNeedingState`, and removes the row on success. Server page saves go through `savePageIfVersion` with the version it read.

- [ ] **Step 1: Write failing tests:**
  - `db.test`: `the migration keeps existing pages up to date`. On a DB with a page and ok digests, after migrating, `projectsNeedingPage(db)` is `[]`.
  - `digest-store.test`:
    - `saveDigest numbers saves in order`: two saves give `saved_seq` 1 and 2.
    - `a new ok digest puts its project in projectsNeedingPage`.
    - `savePageIfVersion refuses a stale base version`: `{ ok: false }`.
    - `markStateDirty bumps the version`.
    - `markSummaryToFollow removes the digest text and its search entry`: a search for a word unique to the old digest finds no digest hit.
    - `nextDueDigest skips summary_to_follow sessions`.
  - `worker.test`:
    - `never builds a page for a project whose digests a computer wrote`: insert a computer digest and a dirty page, run `runOnce`, and assert it returns `'idle'` with 0 model calls.
    - `builds the page after a fallback digest`: the existing test still passes.
- [ ] **Step 2: Run** `pnpm vitest run apps/server/test/digest-store.test.ts apps/server/test/worker.test.ts apps/server/test/db.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement the migration, store functions and worker change.**
- [ ] **Step 4: Run** `pnpm test`. Expected: all pass.
- [ ] **Step 5: Commit** with message `Store who wrote each summary and version the state pages`.

### Task 5: Server ingest endpoints for digests

**Files:**
- Modify: `apps/server/src/http.ts`, `apps/server/src/validate.ts`, `apps/server/src/store.ts`, `apps/server/src/main.ts` (pass `serverSummaries: Boolean(process.env.ANTHROPIC_API_KEY)` into `AppDeps`)
- Test: `apps/server/test/http.test.ts`

**Interfaces:**
- `validate.ts`: `parseUploadDigest(value: unknown): UploadDigest | undefined` checks `body` with `DigestSchema`, and `model`, `refused` and `failed` as non-empty strings (at most 500 characters). It throws `HttpError(400, …)`.
- `store.ts`: `storeUpload(db, session: HashedSession, digest: UploadDigest | undefined, writtenBy: string, now: string): { changed: boolean }` runs `upsertSession` and then, for a main session with a digest, `saveComputerOutcome`, both in one transaction. A digest sent for an unchanged session is still saved (an idempotent retry after a network error).
- Routes, all with `ingest` scope. Match these **before** the existing `sessionPath` and `projectPath` regexes: ids and keys are URL-encoded, so they contain no raw `/`.
  - `PUT /api/sessions/{source}/{id}`: the body is the session JSON plus an optional `digest` field. Response as today.
  - `GET /api/sessions/{source}/{id}` → `{ session: HashedSession }`, built from `sessions` and `messages`. 404 when the session is missing.
  - `PUT /api/sessions/{source}/{id}/digest` with `{ hash: string; digest: UploadDigest }` → `204`, or `409 { error: 'The session changed since this summary was written' }`.
  - `GET /api/projects/{key}/digests` → `{ sessions: { source, id, content_hash, last_activity_at, status, model, written_by, summary_to_follow }[] }`. Main sessions only, without `note` or `doc`.
  - `GET /api/status` gains `server_summaries: boolean`, `pages_needed: string[]` and `summaries_owed: number` (the count of `summary_to_follow = 1`).
- `writtenBy` is the bearer credential's label (`actorFor`).

- [ ] **Step 1: Write failing tests** in `http.test.ts`:
  - `stores a session and its digest in one upload`: afterwards the digest status is `ok`, `written_by` is the token label, and the worker has nothing due.
  - `a main session without a digest becomes pending (older collectors)`.
  - `summary_to_follow removes the old summary and marks the page dirty`.
  - `rejects a digest body that does not match the schema with 400`.
  - `PUT digest answers 409 when the hash moved`.
  - `GET session returns the stored messages`.
  - `GET project digests lists writer and model`.
  - `status reports server_summaries, pages_needed and summaries_owed`.
  - `a read token cannot use the new routes`, which asserts 403.
- [ ] **Step 2: Run** `pnpm vitest run apps/server/test/http.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement the routes.**
- [ ] **Step 4: Run** `pnpm test`. Expected: all pass.
- [ ] **Step 5: Commit** with message `Accept summaries written on the computer with each upload`.

### Task 6: Server page endpoints

**Files:**
- Modify: `apps/server/src/http.ts`, `apps/server/src/digest-store.ts`
- Test: `apps/server/test/http.test.ts`

**Interfaces:**
- `pageInputs(db, projectId: number): { page: { summary; body; version; rebuilt_at; dirty; digests_through } | null; digests: (PageDigest & { saved_seq: number })[]; through: number }`. `digests` holds every ok main digest, oldest first. `through` is the max `saved_seq` among them, or 0.
- `GET /api/projects/{key}/page-inputs` → the `pageInputs` result. 404 for an unknown project.
- `PUT /api/projects/{key}/page` with `{ summary: string; body: string; model: string; base_version: number | null; full_rebuild: boolean; through: number }` → `200 { version }`, or `409 { error: 'The page changed; fetch it again' }`. `DELETE /api/projects/{key}/page` removes a page whose project has no digests left.

- [ ] **Step 1: Write failing tests:**
  - `page-inputs returns all ok digests oldest first with their saved_seq`.
  - `saving with the current version succeeds and clears projectsNeedingPage for that project`.
  - `saving with an old version answers 409`.
  - `a digest saved after the inputs were read keeps the project in pages_needed`: read inputs, save a new digest, save the page with the old `through`, and assert the key is still in `pages_needed`.
- [ ] **Step 2: Run** the http tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test`. Expected: all pass.
- [ ] **Step 5: Commit** with message `Let a computer read page inputs and save pages with a version check`.

### Task 7: Notes without a key, dashboard and docs

**Files:**
- Modify: `apps/server/src/notes.ts` (write the note digest at save time: `noteDigest` moves here from `worker.ts`), `apps/server/src/worker.ts`, `apps/server/src/web/health.ts`, `apps/server/src/web/pages.ts`, `deploy/.env.example`, `README.md`, `deploy/README.md`
- Test: `apps/server/test/notes.test.ts`, `apps/server/test/web-health.test.ts`, `apps/server/test/web-pages.test.ts`

**Interfaces:**
- `saveNote` calls `saveDigest(db, { …, model: 'note', writtenBy: null })` right after `upsertSession`. The worker no longer handles notes.
- `health.ts`:
  - Remove the `digests-off` notice.
  - Add `pages-behind`: "N project pages are waiting to be updated by a computer's next sync", shown when `projectsNeedingPage(db).length > 0`.
  - Add `summaries-waiting`, shown only when `!cfg.digestsOn` and there are `pending` digests with `summary_to_follow = 0`: "N sessions arrived without a summary and the server has no model key. Run `hub resummarize` on a computer with Claude Code."
- `pages.ts`: the digest status cell appends "· by <written_by>", or "· by the server" when NULL and `model` isn't `note`.
- Docs: `ANTHROPIC_API_KEY` is described as optional, used only as a fallback for computers without Claude Code. The README's summaries section describes Claude Code on the computer writing them with Sonnet 5.5 on the owner's plan, the 20-per-sync cap and `--all`.

- [ ] **Step 1: Write failing tests:**
  - `saving a note writes its digest with no worker and no key`.
  - `no digests-off notice when the server has no key`.
  - `pages-behind notice lists the count`.
  - `the session page shows who wrote the summary`.
- [ ] **Step 2: Run** the three test files. Expected: FAIL.
- [ ] **Step 3: Implement**, and update the docs.
- [ ] **Step 4: Run** `pnpm test`. Expected: all pass.
- [ ] **Step 5: Commit** with message `Make the model key optional on the server`.

### Task 8: `ClaudeCodeLlm` in the collector

**Files:**
- Create: `apps/collector/src/claude-llm.ts`, `apps/collector/test/claude-llm.test.ts`, `apps/collector/test/fixtures/claude-*.json` (ok, refusal, not logged in, usage limit)
- Modify: `apps/collector/src/config.ts` (`summaries` settings), `apps/collector/package.json` (add `zod` only if core's dependency doesn't resolve through the workspace)

**Interfaces:**
- `config.ts`: `Config.summaries?: { model?: string; effort?: Effort }`, plus `DEFAULT_SUMMARY_MODEL = 'claude-sonnet-5-5'`, `DEFAULT_SUMMARY_EFFORT = 'low'` and `SUMMARY_CAP = 20`. These settings are **not** part of `settingsFingerprint`: changing the model must not re-upload everything.
- `claude-llm.ts`:
  - `cleanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv`
  - `findClaude(): string | null`. On win32 it runs `where claude` and accepts only a `.exe`; elsewhere it uses `command -v claude`. It returns null for a `.cmd`-only install (doctor explains).
  - `type ClaudeRunner = (cmd: string, args: string[], stdin: string, env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<{ status: number | null; stdout: string; stderr: string; timedOut: boolean }>` with a default `spawnRunner` (`spawn` with `shell: false` and `windowsHide: true`).
  - `class UsageLimitError extends Error { constructor(readonly resetsAt: string | null) }`, `class ClaudeSignInError extends Error`
  - `class ClaudeCodeLlm extends PromptedLlm` with constructor `{ model: string; effort: string; cmd: string; run?: ClaudeRunner; timeoutMs?: number /* default 300_000 */ }`. Its `ask` builds the global-constraint flags, using `jsonSchemaOf(call.schema)` and `call.system` as argv entries and `call.user` on stdin. It parses stdout JSON:
    - `stop_reason === 'refusal'` → `LlmRefusal`
    - `api_error_status === 401` or "Not logged in" → `ClaudeSignInError`
    - `api_error_status === 429`, or `result` matching `/usage limit|limit reached/i` → `UsageLimitError` (with the reset time if the text carries one)
    - `is_error` or a missing `structured_output` → `Error`
    - a timeout → `Error('claude did not answer within …')`
    - otherwise → `structured_output`

- [ ] **Step 1: Write failing tests** with a fake runner:
  - `cleanEnv drops ANTHROPIC_ and CLAUDE variables only`. The input includes `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_SIMPLE`, `CLAUDECODE`, `PATH`, `HOME`, `USERPROFILE` and `APPDATA`; assert the exact keys left.
  - `passes the prompt and schema as single argv entries`: a system prompt containing `"quotes"` and newlines, and the schema, each arrive as exactly one argv element. Assert the `--json-schema` value parses back to `jsonSchemaOf(DigestSchema)`.
  - `sends the transcript on stdin, never in argv`.
  - `uses the configured model and effort, and never --bare`.
  - `returns structured_output from the ok fixture`.
  - `throws LlmRefusal, ClaudeSignInError and UsageLimitError for the matching fixtures`.
  - `throws on a timeout`.
- [ ] **Step 2: Run** `pnpm vitest run apps/collector/test/claude-llm.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the test again. Expected: PASS.
- [ ] **Step 5: Commit** with message `Write summaries with Claude Code on this computer`.

### Task 9: Summarize before upload in `hub sync`

**Files:**
- Create: `apps/collector/src/summaries.ts`, `apps/collector/test/summaries.test.ts`
- Modify: `apps/collector/src/sync.ts`, `apps/collector/src/upload.ts`, `apps/collector/src/config.ts` (`StateEntry` gains `digest_failures?: { hash: string; count: number }`; `State` gains `last_waiting?: { count: number; reason: string | null; at: string }`)
- Test: `apps/collector/test/sync.test.ts`

**Interfaces:**
- `upload.ts`:
  - `putSession(remote, session, digest?: UploadDigest)`
  - `putDigest(remote, ref: { source: string; id: string }, hash: string, digest: UploadDigest): Promise<'saved' | 'moved'>`
  - `getSession(remote, ref): Promise<HashedSession>`
  - `listProjectDigests(remote, key)`
  - `getPageInputs(remote, key)`
  - `putPage(remote, key, page): Promise<{ ok: true; version: number } | { ok: false }>`
  - `deletePage(remote, key)`
  - `getStatus` (now typed: `server_summaries`, `pages_needed`, `summaries_owed`)
- `summaries.ts`:
  - `Budget = { left: number | null /* null: --all */; stopped: string | null }`
  - `summarize(llm: Llm, session: HashedSession, maxChars: number): Promise<UploadDigest>`: `LlmRefusal` → `{ refused, model }`. It rethrows `UsageLimitError`, `ClaudeSignInError` and other errors.
  - `catchUpOwed(remote, llm, projects: string[], budget: Budget, onDone)`: for `summary_to_follow` sessions in the selected projects, it runs `getSession`, then `summarize`, then `putDigest`.
- `SyncOptions` gains:
  - `llm?: Llm | null`: injected for tests. `undefined` builds a `ClaudeCodeLlm` from config and `findClaude()`; `null` means Claude Code was not found.
  - `all?: boolean`
- `SyncReport` gains:
  - `summarized: SessionRef[]`, `wouldSummarize: SessionRef[]`
  - `waiting: { count: number; reason: string | null }`
  - `pages: { updated: string[]; left: string[] }` (filled by Task 10)

**Sync order** (spec decision 5, plus the re-clean exception in decision 6):
1. Scan as today. `recleaning = (state.fingerprint !== fingerprint)`; expose `force` from `scan`.
2. Upload documents as today.
3. In a re-cleaning sync, every selected item already uploaded (`prev.hash !== null`) whose cleaned hash differs uploads at once. Main sessions carry `{ summary_to_follow: true }`; subagents carry no digest. This step ignores the cap.
4. If `llm` is set: `catchUpOwed` within the budget.
5. New or changed main sessions, sorted by `last_activity_at` descending, within the budget. Each one runs `summarize`, then `putSession` with the digest, then its changed subagents.
   - On `UsageLimitError` or `ClaudeSignInError`: set `budget.stopped` and make no more model calls.
   - On another error: increment `digest_failures` for that hash. At 3, upload `{ failed: message }`.
   - Don't update the local state of a waiting session or its subagents.
   - If `llm` is null and `server_summaries` is true, upload without a digest. If both are false, wait, with reason "Claude Code is not installed".
6. Changed subagents whose parent is already on the hub and unchanged upload as today.
7. `report.waiting` and `state.last_waiting` are set. Dry run makes no model call and fills `wouldSummarize`.

- [ ] **Step 1: Write failing tests** in `sync.test.ts` (with `FakeLlm` and the existing fake fetch helpers):
  - `uploads a new main session together with its digest`.
  - `writes at most 20 digests per sync, newest first, and --all lifts the cap`, with 25 sessions.
  - `a session whose digest fails is not uploaded and is retried next sync`.
  - `stops summarizing when the limit is hit mid-session`: a long session fails on part 2 with `UsageLimitError`. Assert no PUT for it, no further model call, and the waiting reason mentions the limit.
  - `makes no more model calls after an upload fails`.
  - `uploads a refused session marked refused`.
  - `uploads failed after the same content fails on 3 syncs`.
  - `holds a waiting session's subagents back`.
  - `uploads a subagent at once when its parent is already on the hub`.
  - `re-cleaning uploads changed sessions at once with summary_to_follow, outside the cap`.
  - `catches up owed summaries from the server before new work`.
  - `without Claude Code, uploads without a digest only when the server has a key`.
  - `dry run calls no model`.
- [ ] **Step 2: Run** `pnpm vitest run apps/collector/test/sync.test.ts apps/collector/test/summaries.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** Keep `sync.ts` focused on scanning and order. Summary and remote steps live in `summaries.ts`.
- [ ] **Step 4: Run** `pnpm test`. Expected: all pass.
- [ ] **Step 5: Commit** with message `Summarize sessions before uploading them`.

### Task 10: State pages built on the computer

**Files:**
- Modify: `apps/collector/src/summaries.ts`, `apps/collector/src/sync.ts`
- Test: `apps/collector/test/summaries.test.ts`

**Interfaces:**
- `updatePages(remote, llm: Llm, keys: string[], budget: Budget, opts: { now: string; maxChars: number; writtenBy?: string; forceRebuild?: boolean }): Promise<{ updated: string[]; left: string[] }>`. For each key:
  1. `getPageInputs`, with `fresh` = digests whose `saved_seq > page.digests_through`.
  2. `buildStatePage`.
  3. `putPage` with `base_version = page?.version ?? null`, `through` from the inputs, and `full_rebuild`.
  4. On `{ ok: false }`, start again from step 1, at most 2 more times; then add the key to `left`.
  5. On a `null` result, `deletePage`.

  It stops at once on `UsageLimitError` (setting `budget.stopped`) and leaves the remaining keys in `left`.
- `runSync` calls it last, for `status.pages_needed` (fetched after the uploads) ∩ the selected tracked projects, when `llm` is set and `budget.stopped` is null.

- [ ] **Step 1: Write failing tests:**
  - `merges only digests newer than the page`.
  - `rebuilds a dirty page`.
  - `retries a refused page save twice, then leaves it`: assert 3 `putPage` calls and the key in `left`, with no thrown error.
  - `deletes the page when the project has no digests`.
  - `skips pages once the usage limit is hit`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test`. Expected: all pass.
- [ ] **Step 5: Commit** with message `Build project state pages on the computer`.

### Task 11: Auto-sync lock, CLI and doctor

**Files:**
- Modify: `apps/collector/src/auto.ts`, `apps/collector/src/cli.ts`
- Test: `apps/collector/test/auto.test.ts`, `apps/collector/test/cli.test.ts`

**Interfaces:**
- `auto.ts`:
  - `startLockHeartbeat(lockPath: string, now: () => Date, everyMs = 60_000): () => void` rewrites the lock's timestamp while `runAutoChild` works. The returned function stops it, and the `finally` calls it.
  - The auto log line adds `, N summarized, M waiting`.
- `cli.ts`:
  - `hub sync --all`.
  - `printReport` adds "N summaries written", and for waiting sessions "N sessions waiting: <reason>". Reasons: "Claude usage limit reached (resets <time>)", "Claude Code is not signed in. Run: claude", "Claude Code is not installed", "cap of 20 reached. Run hub sync --all to catch up". It also adds "N pages left for the next sync".
  - `hub status` shows `last_waiting` and the server's `pages_needed` and `summaries_owed`.
  - `hub doctor` adds a "Summaries" row. It shows ✓ when `findClaude()` finds `claude` and `claude auth status --json` (run with `cleanEnv`) reports signed in, plus the model and effort. It shows ! when `claude` is missing but the server has a key ("the server will summarize this computer's sessions"), and ✗ otherwise.
  - `hub summaries` prints the model and effort. `hub summaries model <id>` and `hub summaries effort <low|medium|high|xhigh|max>` save them. Add all three to the help text.

- [ ] **Step 1: Write failing tests:**
  - `auto.test`:
    - `a heartbeat keeps the lock fresh past 10 minutes`: with a fake clock, a second `takeLock` at +11 min returns false while the heartbeat runs.
    - `the lock is removed after the run`.
  - `cli.test`:
    - `sync --all passes all to runSync`.
    - `prints the waiting reason`.
    - `doctor reports Claude Code signed in`, with an injected `runClaude`.
    - `hub summaries model saves the model without changing the settings fingerprint`.
- [ ] **Step 2: Run** `pnpm vitest run apps/collector/test/auto.test.ts apps/collector/test/cli.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The doctor's `runClaude` dependency becomes `runClaude?: (args: string[]) => { found: boolean; output: string }` so both `mcp list` and `auth status` go through it.
- [ ] **Step 4: Run** `pnpm test`. Expected: all pass.
- [ ] **Step 5: Commit** with message `Show summary progress in sync, status and doctor`.

### Task 12: `hub resummarize`

**Files:**
- Create: `apps/collector/src/resummarize.ts`, `apps/collector/test/resummarize.test.ts`
- Modify: `apps/collector/src/cli.ts`

**Interfaces:**
- `runResummarize(opts: { hubDir: string; project?: string; all?: boolean; modelNot?: string; llm?: Llm | null; fetchImpl?: typeof fetch; now?: () => Date }): Promise<{ rewritten: SessionRef[]; waiting: { count: number; reason: string | null }; pages: { updated: string[]; left: string[] } }>`
- A session qualifies when it is in a tracked project, its model is not `note`, and any of these holds:
  - it was written by the server (`written_by === null`);
  - its status is `pending`, `failed` or `refused`;
  - `modelNot` is set and its model is not `modelNot`.
- Order is newest first, with the same `Budget`, cap and `--all` as sync. For each session: `getSession`, then `summarize`, then `putDigest`. A `moved` answer means the session changed since; skip it and count it as waiting. Afterwards, `updatePages(…, { forceRebuild: true })` runs for every project touched.
- CLI: `hub resummarize [<project>] [--all] [--model-not <id>]` prints counts like sync. It fails with the doctor's message when Claude Code is missing.

- [ ] **Step 1: Write failing tests:**
  - `rewrites server-written digests and leaves notes alone`.
  - `leaves computer-written digests unless --model-not names another model`.
  - `respects the cap and --all`.
  - `fully rebuilds the touched pages`.
  - `skips a session that moved since it was listed`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test`. Expected: all pass.
- [ ] **Step 5: Commit** with message `Add hub resummarize to rewrite older summaries`.

### Task 13: End to end, and the deviations log

**Files:**
- Create: `apps/collector/test/e2e-local-summaries.test.ts`, `docs/superpowers/plans/local-summaries-deviations.md`

- [ ] **Step 1: Write the end-to-end test.** Start a real server via `apps/server/test/helpers.ts` with **no** key and **no** worker. Run `runSync` with a fake `ClaudeRunner` that returns fixture JSON. Assert:
  - the session is searchable over `/mcp` with its digest;
  - `get_project` returns a page written by the computer;
  - a second computer (second token) with a stale page version gets 409 and then succeeds;
  - no request carried an `ANTHROPIC_` header;
  - the server made 0 model calls.
- [ ] **Step 2: Run** `pnpm test && pnpm typecheck`. Expected: all pass.
- [ ] **Step 3: Write the deviations log.** Record the "behind is computed, `dirty` keeps its meaning" deviation and anything else that changed during the build, in the style of `docs/superpowers/plans/model-spend-deviations.md`.
- [ ] **Step 4: Commit** with message `Test local summaries end to end and log deviations`.
