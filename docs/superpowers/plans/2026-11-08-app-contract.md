# App Contract (Phase 2, context-hub) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the context-hub server (`apps/server`, deployed at hub.abdulmughnialfikri.com) to the platform "app contract": versioned `/healthz`, JSON-line logs with `LOG_LEVEL`, a per-request access log with `X-Request-Id`, and documented operations.

**Architecture:** A small dependency-free `logger.ts` in `apps/server/src` writes one JSON object per line to stdout/stderr. `createHandler` in `http.ts` wraps every request with a request id and an access-log line, and `/healthz` checks the SQLite DB. `main.ts` validates `LOG_LEVEL` at startup and routes all former `console.*` calls through the logger. The Dockerfile bakes `APP_VERSION` from a `GIT_SHA` build arg that the deploy workflow supplies.

**Tech Stack:** TypeScript (ESM), node:http, better-sqlite3, vitest, pnpm workspace.

**Spec:** `C:\Users\abdul\project\vps-stack\docs\superpowers\specs\2026-11-08-app-platform-standard-design.md` §5 (requirements restated in the task brief).

## Global Constraints

- Logs: stdout/stderr only; one JSON object per line with `ts` (ISO 8601), `level` (`debug|info|warn|error`), `msg`, plus fields. No `app` field.
- `LOG_LEVEL` default `info`; invalid value fails startup with a message naming `LOG_LEVEL`.
- Access line fields: `method`, `path` (no query string), `status`, `ms`, `req_id`; response header `X-Request-Id`. Never log headers, cookies, Authorization, bodies, tokens, emails.
- `/healthz`: unauthenticated; `200 {"ok":true,"version":"<sha>"}`, `503 {"ok":false,"version":...}` if SQLite is unusable. No secrets, counts or hostnames.
- No new dependencies. Do not push, merge, or touch `main`. No secrets.
- CLI/client packages (`apps/collector`, `admin-bin.ts`) keep printing to the terminal.

## Review Focus

- Query string containing a token (`/x?token=abc`) must never appear in any log line.
- Client-supplied `X-Request-Id` must not be echoed or logged (always generate our own).
- A request aborted mid-flight still gets exactly one access line.
- `/healthz` with a closed DB returns 503, not a crash/500 with a stack.
- Docker healthcheck still passes on 200 (it only checks `r.ok`).

---

### Task 1: Logger module

**Files:**
- Create: `apps/server/src/logger.ts`
- Test: `apps/server/test/logger.test.ts`

**Interfaces:**
- Produces:
  - `type Level = 'debug' | 'info' | 'warn' | 'error'`
  - `parseLogLevel(raw: string | undefined): Level` — undefined/blank → `'info'`; case-insensitive; otherwise throws `Error('LOG_LEVEL must be one of: debug, info, warn, error (got "<raw>")')`.
  - `interface Logger { debug/info/warn/error(msg: string, fields?: Record<string, unknown>): void; setLevel(l: Level): void }`
  - `createLogger(level: Level, write?: (line: string, level: Level) => void): Logger` — default write sends `warn`/`error` to `process.stderr`, others to `process.stdout`, line + `\n`. Lines below `level` are dropped. Object is `{ts, level, msg, ...fields}`; reserved keys `ts|level|msg` in `fields` cannot override.
  - `export const logger: Logger` — shared instance, level `info` until `logger.setLevel` is called by `main.ts`.

- [ ] **Step 1: Failing tests** — `logger.test.ts`: `parseLogLevel(undefined)==='info'`; `'DEBUG'→'debug'`; `'loud'` throws matching `/LOG_LEVEL/`; at level `warn`, `info` is dropped and `warn`/`error` emitted; emitted line `JSON.parse`s to `{ts (ISO, Date.parse not NaN), level:'warn', msg:'x', a:1}` with no `app` key; a field named `level` does not override.
- [ ] **Step 2:** Run `pnpm --filter @context-hub/server exec vitest run test/logger.test.ts` → FAIL.
- [ ] **Step 3:** Implement `logger.ts` as specified.
- [ ] **Step 4:** Run tests → PASS.
- [ ] **Step 5:** Commit `Add a JSON-line logger for the server`.

### Task 2: Access log, request id, healthz, console replacement

**Files:**
- Modify: `apps/server/src/http.ts` (AppDeps, `/healthz`, returned handler), `apps/server/src/main.ts`, `apps/server/src/activity.ts:47`, `apps/server/src/llm-anthropic.ts:50`, `apps/server/src/worker.ts:54,186`
- Test: `apps/server/test/http.test.ts` (update healthz test), create `apps/server/test/access-log.test.ts`

**Interfaces:**
- Consumes: Task 1 `Logger`, `logger`, `parseLogLevel`.
- Produces: `AppDeps` gains `logger?: Logger` (default shared `logger`) and `version?: string` (default `process.env.APP_VERSION ?? 'dev'`). `deps.log` stays; its default becomes `(line) => logger.info(line)`; the 500 path logs via `logger.error('unhandled error', {err})` (stack included as a field — it is server-generated, not request data).

- [ ] **Step 1: Failing tests** (`access-log.test.ts`, using `startServer` from helpers with a capturing `createLogger('debug', ...)`):
  - GET `/api/status?token=secret` (no auth) → 401; captured access line has `method:'GET'`, `path:'/api/status'`, `status:401`, numeric `ms`, string `req_id`; the whole captured text does not contain `secret`.
  - Response header `x-request-id` equals the line's `req_id`; a request sending `X-Request-Id: evil` gets a different id and `evil` is absent from the log.
  - No logged line contains `authorization`/the bearer token when an Authorization header is sent.
  - `/healthz` → 200 body `{ok:true,version:'abc123'}` when `version:'abc123'` is passed; with a closed `db` → 503 `{ok:false,version:'abc123'}`; no token needed.
  - Update the existing http.test healthz assertion accordingly.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. In the returned `(req,res)` handler: `req_id = randomUUID()`, `res.setHeader('X-Request-Id', id)`, start `performance.now()`, on `res.once('close')` emit exactly one `info` line `msg:'request'` with the fields above (`path` from `new URL(req.url,'http://local').pathname`, falling back to `'/'` on parse failure); `/healthz` lines are logged at `debug` (the container healthcheck hits it every interval). `/healthz` handler runs `db.prepare('SELECT 1').get()` in try/catch. `main.ts`: `logger.setLevel(parseLogLevel(process.env.LOG_LEVEL))` first (before DB open); replace every `console.*` with `logger.*` (digest-budget warning → `logger.warn`; listening line → `logger.info('listening', {port})`; fields rather than interpolated paths where natural). Replace default `console.log/error` in activity/worker/llm-anthropic with `logger`.
- [ ] **Step 4:** Run `pnpm test && pnpm typecheck` → all pass.
- [ ] **Step 5:** Commit `Log requests as JSON lines and report the version from /healthz`.

### Task 3: Dockerfile, deploy workflow, compose env, docs

**Files:**
- Modify: `Dockerfile`, `.github/workflows/deploy.yml`, `deploy/.env.example`, `deploy/README.md:26`, `README.md` (Settings table, Monitoring → Operate)

- [ ] **Step 1:** Dockerfile runtime stage: `ARG GIT_SHA=dev` then `ENV APP_VERSION=$GIT_SHA` (after `FROM ... AS runtime` so it is not lost). Deploy workflow `build-args`: add `GIT_SHA=${{ github.sha }}` on its own line beside `HUB_VERSION`.
- [ ] **Step 2:** Document `LOG_LEVEL` (default `info`, `debug|info|warn|error`) in README Settings table and `deploy/.env.example`. (`deploy/docker-compose.yml` uses an env file; check whether it lists variables explicitly and add `LOG_LEVEL` only if it does.)
- [ ] **Step 3:** README: replace "Monitoring" with an "Operate" section: health `/healthz` → `{"ok":true,"version":"<sha>"}` (503 when DB unusable); gated path `/api/status` (401 without auth); state `sqlite-volume` at `/data`, backed up by vps-stack's `backup-context-hub.sh`; required env (`PUBLIC_URL`; optional others → Settings); logs JSON lines with `LOG_LEVEL`; rollback by setting `IMAGE_TAG` in the stack `.env` to an older `sha-…` and `docker compose up -d`. Fix `deploy/README.md` healthz sentence.
- [ ] **Step 4:** `pnpm test && pnpm typecheck`; `git diff --stat` sanity check. Commit `Document the operating contract and stamp the build version`.
