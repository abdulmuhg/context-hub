# context-hub Model Spend — Implementation Plan

> **For agentic workers:** Implement task by task in order. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A bulk upload costs a fraction of what it does today, no model call is billed at the long-prompt price, and the owner can see, and cap, what summaries cost.

**Architecture:** All changes are in the server (`apps/server`). The worker stops updating a project's state page after every digest while more of that project's digests are queued, and rebuilds the page once instead. Prompt sizes get a safer characters-per-token estimate so they stay under the 100K-token price step. Every model call's real token counts are saved to a new table, priced, shown on the dashboard and through `hub-admin usage`, and an optional daily limit pauses the worker when it is reached. No collector changes.

**Tech Stack:** TypeScript (NodeNext ESM), Node 22, better-sqlite3, `@anthropic-ai/sdk`, vitest. No new dependencies.

## Why (measured on 2026-10-21)

The Mac's first sync uploaded 222 sessions of one project. The worker then made about 900 model calls, with about 27M input tokens by estimate:

| Step | Calls | Input tokens (est.) | Share |
|---|---|---|---|
| Digest each session (28 needed 2+ parts) | ~340 | ~8.9M | 33% |
| Merge each digest into the state page | ~280 | ~0.9M | 3% |
| Review the page against recent digests, after **every** digest | ~280 | ~17M | 63% |

Two causes, plus one gap:
1. **Per-digest page updates.** `digestOne` (`worker.ts`) calls `updateStateAfterDigest` after every digest, and every page update ends with `reviewPage`. That call sends up to `maxChars` of the project's digests each time. For a bulk upload, almost all of these calls are wasted: the next digest replaces the page a minute later.
2. **The prompt limit sits at the price step.** `DEFAULT_MAX_INPUT_TOKENS = 80000` is turned into characters at `CHARS_PER_TOKEN = 3`, so 240,000 characters. Code-heavy transcripts tokenize nearer 2–2.5 characters per token, so a "full" prompt is about 96–120K real tokens. Claude Haiku 5.5 bills prompts over 100K tokens at $0.50 / $2.50 per million instead of $0.10 / $0.50, which is 5×.
3. **No record of spend.** The hub never stores `response.usage`, so none of this was visible until the credit ran out.

## Design (agreed with the owner)

**Part A — one page build per batch.**
- After saving a digest, the worker checks whether another digest of the **same project** is still due: a main session (`parent IS NULL`), not a document, with status `pending`, or `failed` with `next_attempt_at <= now`.
- If so, it skips `updateStateAfterDigest` and calls `markStateDirty(project)`. If the project has no page yet, it does nothing: `nextProjectNeedingState` already picks up a project with ok digests and no page.
- If not (the usual case of one new session), it updates the page exactly as today: a merge, then a review.
- `runOnce` already does every due digest before any state work, so dirty pages are rebuilt once each when the queue is empty. Each rebuild is one `projectState` call plus one `reviewState` call.
- While the backlog drains, the page is marked stale (`stale: true` in `get_project`). That is correct: it is stale.

**Part B — stay under the 100K-token price step.**
- `CHARS_PER_TOKEN` becomes `2`, a pessimistic estimate, and `DEFAULT_MAX_INPUT_TOKENS` becomes `60000`. A transcript part or a digest window is then at most 120,000 characters, which is at most about 60–80K real tokens even for dense code, plus the system prompt.
- The review window (`reviewPage`) and the rebuild window (`rebuildState`) already use `maxChars`, so they shrink with it.
- `main.ts` logs one warning at startup when `DIGEST_MAX_INPUT_TOKENS` is set above `80000`: `DIGEST_MAX_INPUT_TOKENS is <n>: with 2 characters per token, a full prompt can pass 100K tokens, which some models bill at a higher rate.` It still starts.
- Part C's records show each call's real input size, so this estimate can be checked (Review Focus 3).

**Part C — record, show and cap spend.**
- Every model call is recorded with its real usage in a new table `model_usage`:
  - the time and model;
  - the kind: `digest`, `merge`, `state`, `shorten` (the second `projectState` call that shortens an over-long page) or `review`;
  - the project key;
  - `input_tokens` and `output_tokens`; output includes thinking tokens, which are billed as output;
  - `cache_read_tokens` and `cache_write_tokens`, saved for completeness (the hub does not use caching yet);
  - `cost_micro_usd`: an integer, or null for a model with no known price.
- Prices live in one table in code. It is keyed by model, with an optional step: above `step_tokens` input tokens, the whole call uses the higher rate.
  - `claude-haiku-5-5`: $0.10 / $0.50 per million up to 100,000 input tokens, $0.50 / $2.50 above.
  - Verify these numbers against the current pricing page before implementing, and log any difference as a deviation.
  - Any other model gets null cost, and only its tokens are shown.
- Rows are kept 90 days, pruned when a row is written, the way the activity log prunes.
- **Dashboard, Overview:** a sixth card, **Model spend**. Its main figure is today's spend (UTC day), for example `$0.42`. Its subline is `<n> calls today · $<x> in 30 days`. With a daily limit, the subline also says `· limit $<l>`. When no call has been recorded it reads `$0.00` with the subline `No model calls recorded yet`.
- **`hub-admin usage [--days N]`**, default 7 days: one line per UTC day with calls, input tokens, output tokens and cost. After that, a breakdown by kind and by project for the whole period. Calls over 100,000 input tokens are counted on their own line, as `over the 100K price step: <n> calls`.
- **Daily limit:** the optional env var `DIGEST_DAILY_BUDGET_USD`, a positive number, with no limit when unset.
  - Before each job, `runOnce` checks today's spend. When it is at or over the limit, it does no model work and returns `'idle'`.
  - The limit is soft. A job already started finishes, so a multi-part session can go one job over. This is documented.
  - When the limit is reached, Overview shows a problem: `Summaries paused: today's model spend reached the $<l> daily limit. They resume at 00:00 UTC.`
  - A paused worker also leaves saved notes waiting. A note makes no model call (`noteDigest`), but a page update after it does, and splitting the two is not worth it. Document this.

## Global Constraints

- Migration 8 adds `model_usage(id INTEGER PRIMARY KEY, at TEXT NOT NULL, model TEXT NOT NULL, kind TEXT NOT NULL, project_key TEXT, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0, cost_micro_usd INTEGER)` and `CREATE INDEX model_usage_at ON model_usage(at)`. Never edit an existing migration. `db.test.ts` checks the version (`SCHEMA_VERSION` becomes 8).
- `AnthropicLlm` gets an optional constructor option, `onUsage?: (u: UsageRecord) => void`, where `UsageRecord` is `{ model, kind, project, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens }`.
  - `ask()` calls it after every response that has `usage`, including a refusal or an incomplete answer, since those are billed too.
  - A throwing `onUsage` is caught and logged, and must never fail the call.
  - The `Llm` interface does not change, so `FakeLlm` and the worker's control flow stay as they are.
- `kind` and `project` reach `ask()` as arguments from each public method. `shorten` is the retry inside `projectState`.
- Recording and pricing live in a new `apps/server/src/usage.ts`:
  - `recordUsage(db, u, now)` prices the call and inserts the row;
  - `spendBetween(db, fromIso, toIso)` returns `{ calls, input, output, micro_usd }`;
  - `usageReport(db, days, now)` feeds `hub-admin usage`;
  - `priceMicroUsd(model, input, output)` returns a number or null.
- Money is integer micro-dollars in storage and in sums. Format it only on display, with 2 decimals (`$0.00`), or 4 when the total is under $0.01 but not zero.
- "Today" is the UTC day, `[YYYY-MM-DDT00:00:00.000Z, next day)`, for the card and the limit alike. Document it.
- New env vars: `DIGEST_DAILY_BUDGET_USD`. At startup, a value that is not a positive finite number fails with `DIGEST_DAILY_BUDGET_USD must be a positive number of US dollars`. `WebConfig` gains `dailyBudgetUsd: number | null`, so the health check can name the limit.
- No secret, prompt text or transcript text goes into `model_usage`, only counts.
- Commits carry no Co-Authored-By or other attribution trailers. No new dependencies. All existing tests keep passing.

## Review Focus

1. **A bulk upload builds each page once.** With 5 pending digests of one project and an existing page, draining the queue makes 5 digest calls, 0 merges, 1 rebuild and 1 review. One new digest with a page makes 1 merge and 1 review, as today. Tested in Task 1.
2. **Pages still end up current.** After a backlog drains, no project with ok digests is left dirty or without a page. Digests of another project in the queue do not hold a project's page back once its own digests are done. Tested in Task 1.
3. **No prompt crosses the price step.** With the new defaults, the largest transcript part and the largest review or rebuild window are at most 120,000 characters. Tested in Task 2. After deploy, `hub-admin usage` must show 0 calls over 100K. That is the owner's check, and the reviewer verifies it on the server.
4. **Every billed call is recorded once**, with its kind and project, including refusals and incomplete answers. A failing recorder never fails a call. Tested in Task 3.
5. **The limit stops spend and lifts by itself.** Over the limit, `runOnce` makes no model call and returns `'idle'`, and the Overview shows the problem. After UTC midnight work resumes without a restart. Tested in Task 5.

---

### Task 1: One page build per batch

**Files:** Modify `apps/server/src/worker.ts`, `apps/server/src/digest-store.ts`. Test: `apps/server/test/worker.test.ts`; extend `FakeLlm` in `apps/server/test/helpers.ts` so it also records `review` calls (kind `'review'`), if it does not already.

- [ ] **Step 1: Failing tests** in `worker.test.ts`:
  - five sessions of one project, page present: run until idle, then expect 5 `digest`, 0 `merge`, 1 `state` (rebuild), 1 `review`;
  - the same with no page: 5 `digest`, 1 `state`, 1 `review`;
  - one new session with a page: 1 `digest`, 1 `merge`, 1 `review`, as before;
  - two projects interleaved in the queue: each page is rebuilt once, and neither stays dirty at the end;
  - a failed digest waiting out its backoff does not count as "still due".
- [ ] **Step 2:** In `digest-store.ts`, add `projectHasDueDigest(db, projectId, now): boolean`. It uses the same conditions as `nextDueDigest` (`parent IS NULL`, `source <> 'doc'`, `pending` or due `failed`), limited to one project, excluding nothing else. Call it after `saveDigest`, so the digest just saved is already `ok` and is not counted.
- [ ] **Step 3:** In `digestOne`, after a successful `saveDigest`: if `projectHasDueDigest`, then `markStateDirty` (only when a page exists) and return `'digest'`; otherwise call `updateStateAfterDigest` as today.
- [ ] **Step 4:** Run the worker tests and the whole suite. Commit: `Build a project's state page once per batch of new digests`.

### Task 2: Stay under the 100K-token price step

**Files:** Modify `apps/server/src/worker.ts` (`CHARS_PER_TOKEN = 2`, `DEFAULT_MAX_INPUT_TOKENS = 60000`), `apps/server/src/main.ts` (startup warning), `README.md` (env table), `deploy/.env.example`. Test: `apps/server/test/worker.test.ts`, `apps/server/test/transcript.test.ts` where the numbers appear.

- [ ] **Step 1: Failing tests:**
  - with default deps, a session whose rendered transcript is 300,000 characters is digested in 3 parts, each at most 120,000 characters;
  - a review window over many large digests is at most 120,000 characters of digest text.
- [ ] **Step 2:** Change the two constants. Update every test that hard-codes 80000 or 240000. Each such change is a deliberate new default, not a weakened assertion; list them in the commit body.
- [ ] **Step 3:** Add the startup warning in `main.ts` (text in Design, Part B).
- [ ] **Step 4:** Update the README env row for `DIGEST_MAX_INPUT_TOKENS`: `Default 60000, counted at 2 characters per token so a prompt stays under the 100K-token price step. Long sessions are summarised in parts of this size.` Update `deploy/.env.example` to match. Commit: `Keep model prompts under the 100K-token price step`.

### Task 3: Record every model call

**Files:** Modify `apps/server/src/db.ts` (migration 8), `apps/server/src/llm-anthropic.ts` (`onUsage`, `kind`/`project` through `ask`), `apps/server/src/main.ts` (wire `onUsage` to `recordUsage`). Create `apps/server/src/usage.ts`. Test: `apps/server/test/db.test.ts`, `apps/server/test/llm-anthropic.test.ts`, create `apps/server/test/usage.test.ts`.

- [ ] **Step 1: Failing tests:**
  - migration 8 creates the table, and `SCHEMA_VERSION` is 8;
  - a stub client whose `parse` returns `usage: { input_tokens: 1200, output_tokens: 300 }` produces one `onUsage` call per method, with the right `kind` and `project`, including the `shorten` retry;
  - a `refusal` response and a `max_tokens` response are still recorded;
  - an `onUsage` that throws does not fail the call;
  - `priceMicroUsd('claude-haiku-5-5', 100_000, 1_000)` uses the low rate, `100_001` input uses the high rate for the whole call, and an unknown model gives null;
  - rows older than 90 days are pruned on insert.
- [ ] **Step 2:** Implement `usage.ts` and the migration. Thread `kind` and `project` through `ask(system, user, schema, kind, project)`.
- [ ] **Step 3:** In `main.ts`: `new AnthropicLlm({ model, effort, onUsage: (u) => recordUsage(db, u, new Date().toISOString()) })`.
- [ ] **Step 4:** Commit: `Record the tokens and cost of every model call`.

### Task 4: Show spend on the dashboard and in hub-admin

**Files:** Modify `apps/server/src/web/health.ts` (`cards.spend`), `apps/server/src/web/pages.ts` (sixth card), `apps/server/src/admin.ts` (`usage` command and usage text). Test: `apps/server/test/web-health.test.ts`, `apps/server/test/web-overview.test.ts`, `apps/server/test/admin.test.ts`.

- [ ] **Step 1: Failing tests:**
  - with rows today and yesterday, the card shows today's cost and today's call count, and the 30-day total includes both;
  - with no rows, it shows `$0.00` and `No model calls recorded yet`;
  - `hub-admin usage --days 2` prints one line per day, the by-kind and by-project breakdown, and the over-100K count;
  - a model with null cost shows its tokens, and its cost as `—`.
- [ ] **Step 2:** Implement. The card goes after Last backup. The grid has to wrap cleanly at 6 cards on desktop and stack on a phone. Check it in the browser at both widths, in light and dark.
- [ ] **Step 3:** Commit: `Show model spend on the dashboard and in hub-admin usage`.

### Task 5: Optional daily limit

**Files:** Modify `apps/server/src/main.ts` (parse `DIGEST_DAILY_BUDGET_USD`, pass it to the worker and `WebConfig`), `apps/server/src/worker.ts` (`WorkerDeps.dailyBudgetMicroUsd?: number`, gate in `runOnce`), `apps/server/src/web/health.ts` (problem line), `apps/server/src/web/routes.ts` (`WebConfig.dailyBudgetUsd`), `README.md`, `deploy/.env.example`. Test: `apps/server/test/worker.test.ts`, `apps/server/test/web-health.test.ts`.

- [ ] **Step 1: Failing tests:**
  - with `dailyBudgetMicroUsd` set and today's spend at the limit, `runOnce` returns `'idle'` with a pending digest present, and calls no model;
  - with `now` moved to the next UTC day, the same digest is processed;
  - the Overview shows the paused problem only while the limit is reached;
  - the env var is validated at startup (a test of the parsing function, not of `main.ts` itself).
- [ ] **Step 2:** Implement. The gate runs at the top of `runOnce`, before both the digest and the state branches.
- [ ] **Step 3:** README env table gets a row, `DIGEST_DAILY_BUDGET_USD | no | A daily limit in US dollars for summaries (UTC day). When it is reached, summaries wait until 00:00 UTC; a job already running finishes, so the limit can be passed by one job.`, and a line in the dashboard section about the Model spend card. Same in `deploy/.env.example` (commented out).
- [ ] **Step 4:** Commit: `Add an optional daily limit on model spend`.

### Task 6: Deviations log

- [ ] Write `docs/superpowers/plans/model-spend-deviations.md`. List every place the implementation differs from this plan and why, including any price that differed from the pricing page. Write "None" if nothing did. Commit: `Log model spend deviations`.

## After the plan (owner and reviewer, not the implementer)

- Deploy. Then set `DIGEST_DAILY_BUDGET_USD` in `/opt/stack/context-hub/.env` on the server, if wanted, and recreate the container.
- After the next real sync, `hub-admin usage` should show no calls over 100K, and review calls far below one per digest.
