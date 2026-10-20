# context-hub Dashboard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the JSON landing at `https://hub.abdulmughnialfikri.com/` with a signed-in, owner-only dashboard (Overview, Activity, Projects, Sign-ins) that shows whether the hub is working and what was saved into and read from it.

**Architecture:** Server-rendered HTML from the existing `node:http` handler, in a new `apps/server/src/web/` module, plus one static CSS and one static JS file. A new activity log records uploads, deletes, notes and every MCP tool call; the collector reports each `hub sync` run; browser sign-in reuses Part 5's connect codes and creates an HttpOnly cookie session. Backup health comes from a status file the backup script writes, mounted read-only.

**Tech Stack:** TypeScript (NodeNext ESM), Node 22 `node:http`/`node:crypto`, better-sqlite3, vitest. No new dependencies, no front-end framework, no build step for the pages.

**Spec:** `docs/superpowers/specs/2026-10-20-context-hub-dashboard-design.md`. Read it first; earlier specs in the same folder give background.

## Global Constraints

- Pages: `/` (Overview), `/activity`, `/projects`, `/projects/<encodeURIComponent(project key)>`, `/sign-ins`, `/login`; actions `POST /login`, `POST /logout`, `POST /sign-ins/disconnect`; assets `/assets/app.css`, `/assets/app.js`. Every page except `/login` and the two assets needs a valid browser session; without one, `GET` answers `302` to `/login` and `POST` answers `403`.
- Existing routes keep working unchanged: `/healthz`, `/api/*`, `/mcp`, `/oauth/*`, `/.well-known/*`. The JSON landing at `/` is removed (existing tests for it are rewritten to expect the redirect).
- Browser session: 32 random bytes, stored as a sha256 hash; cookie `hub_session`, `HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000` (30 days). `Secure` is omitted only when `PUBLIC_URL` is unset or `http://localhost…` (tests). Sessions are accepted only by dashboard routes; bearer and OAuth tokens are not accepted there, and sessions are not accepted on `/mcp` or `/api/*`.
- Every POST form carries `csrf`, a per-session random value (stored with the session) checked with a constant-time compare; a mismatch answers `403`.
- Sign-in uses `consumeConnectCode`; wrong codes call `limiter.recordFailure(address)`; a blocked address gets the sign-in page with "Too many wrong codes. Try again in 15 minutes." and status `429`.
- Colours (CSS custom properties, light / dark): background `#FAFAF9` / `#151514`; ink `#18181B` / `#F5F5F3`; card `#FFFFFF` / `#1C1C1A`; hairline `#E7E5E4` / `#2E2E2B`; muted `#78716C` / `#A8A29E`; success `#15704A` / `#2E9E6B`; danger `#B42318` / `#F04438`. Green only for healthy and saved. Fonts: Plus Jakarta Sans (text), Space Mono (times, ids, numbers), with system fallbacks. Radius 6 to 8 px.
- Theme: `data-theme` on `<html>`; first visit follows `prefers-color-scheme`; the switch stores `light`/`dark` in `localStorage` key `hub-theme` (wrapped in try/catch). Phone (< 768 px): sidebar hidden behind a menu button.
- Content-Security-Policy on every page: `default-src 'none'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`. No inline scripts or `style=` attributes. Also `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` on pages.
- Times are rendered as `<time datetime="ISO">` with UTC text; `app.js` rewrites the text to the browser's local time and "x ago".
- Escape every value from the database. Never show a token, code or cookie value.
- Thresholds: sync quiet after 3 days without a reported run; backup late after 26 hours; a pending summary is "backing up" after 1 hour when summaries are on; activity kept 30 days; Activity page shows 50 rows per page.
- Database: one new migration (index 4 → `user_version` 5); never edit an existing migration.
- Commits carry no Co-Authored-By or other attribution trailers. No new dependencies. All existing tests keep passing.

## Review Focus

1. **Signed-out access.** Every data page, including a deep link like `/projects/github.com%2Fabdulmuhg%2Fjsonroom`, answers `302 /login` without leaking a project name in the body or `Location`. Test in Task 4.
2. **Cross-site actions.** A Disconnect or Sign out POST without the right `csrf` field, or with a session cookie but a foreign `Origin`, answers `403` and changes nothing. Test in Task 8.
3. **Project keys with slashes in the URL.** `/projects/` + `encodeURIComponent('github.com/abdulmuhg/jsonroom')` opens that project; an unknown key gives a plain 404 page. Test in Task 7.
4. **Script injection through stored text.** A project title, search query or state page containing `<script>`, `<img onerror>` or a Markdown link `[x](javascript:alert(1))` renders as text, and the link is not a link. Test in Tasks 5 and 7.
5. **Disconnecting yourself.** Disconnecting the current browser signs it out and lands on `/login`; disconnecting the collector's upload token is possible but only after a confirmation screen that says `hub sync` will stop working. Test in Task 8.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/server/src/db.ts` (modify) | Migration 5: `activity`, `sync_runs`, `web_sessions` |
| `apps/server/src/activity.ts` (create) | Log, list, prune and forget activity; record and read sync runs |
| `apps/server/src/tokens.ts` (modify) | Bearer credential carries `id` and `label` |
| `apps/server/src/http.ts` (modify) | Log uploads and deletes, `POST /api/sync-runs`, mount web routes, drop JSON landing |
| `apps/server/src/mcp.ts` (modify) | Log each tool call with its actor |
| `apps/server/src/web/session.ts` (create) | Browser sessions, cookies, CSRF |
| `apps/server/src/web/html.ts` (create) | `escapeHtml`, page shell (sidebar, header, theme switch), security headers |
| `apps/server/src/web/markdown.ts` (create) | Safe Markdown to HTML for state pages |
| `apps/server/src/web/assets.ts` (create) | `app.css` and `app.js` contents and their route |
| `apps/server/src/web/health.ts` (create) | Overview cards and the Problems list |
| `apps/server/src/web/backup-status.ts` (create) | Read the backup status file |
| `apps/server/src/web/pages.ts` (create) | Render Overview, Activity, Projects, project detail, Sign-ins, sign-in |
| `apps/server/src/web/routes.ts` (create) | Dispatch web routes and actions |
| `apps/server/src/main.ts` (modify) | Pass `web` config: image tag, start time, digests on/off, backup status path |
| `apps/collector/src/upload.ts`, `sync.ts`, `cli.ts` (modify) | Report each sync run |
| `~/project/vps-stack/scripts/backup-context-hub.sh`, `context-hub/docker-compose.yml`, `README.md` (modify) | Status file and its read-only mount |

---

### Task 1: Activity log and sync-run storage

**Files:**
- Modify: `apps/server/src/db.ts`
- Create: `apps/server/src/activity.ts`
- Test: `apps/server/test/activity.test.ts`, extend `apps/server/test/db.test.ts`

**Interfaces:**
- Produces (`activity.ts`):
  - `type Direction = 'in' | 'out'`; `type Action = 'upload' | 'delete' | 'note' | 'sync' | 'list_projects' | 'get_project' | 'search' | 'get_session'`
  - `logActivity(db, e: { direction: Direction; action: Action; projectKey: string | null; sessionRef: string | null; actor: string; detail: string | null }, now: string): void` — prunes rows older than 30 days on each call (cheap `DELETE … WHERE at < ?`)
  - `listActivity(db, opts: { direction?: Direction; limit: number; offset: number }): ActivityRow[]` newest first, `ActivityRow = { id; at; direction; action; projectKey; sessionRef; actor; detail }`
  - `forgetActivityForSession(db, sessionRef: string): void`, `forgetActivityForProject(db, projectKey: string): void`
  - `recordSyncRun(db, r: { tokenId: number; finishedAt: string; uploaded: number; unchanged: number; errors: number }, now: string): void` — also logs an `in`/`sync` activity row with detail `"<uploaded> uploaded, <unchanged> unchanged[, <errors> errors]"`
  - `latestSyncRun(db): SyncRun | null` (across all tokens, newest `finished_at`)

- [ ] **Step 1: Write the failing tests** in `activity.test.ts`: logging and listing newest first with a direction filter and paging; rows older than 30 days are pruned on the next write; `forgetActivityForSession` removes only that session's rows; `forgetActivityForProject` removes every row with that project; `recordSyncRun` stores the run, adds one `sync` row with the detail text above, and `latestSyncRun` returns the newest. In `db.test.ts`: `SCHEMA_VERSION` is 5 and the three tables exist.
- [ ] **Step 2: Run** `pnpm --filter ./apps/server exec vitest run test/activity.test.ts test/db.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.** Migration 5 creates `activity(id PK, at, direction CHECK, action, project_key, session_ref, actor, detail)` with an index on `at`, `sync_runs(id PK, token_id, finished_at, uploaded, unchanged, errors, received_at)`, and `web_sessions(id PK, hash UNIQUE, csrf, created_at, last_used_at, expires_at, revoked_at)`. If an existing test replays migrations from an older version and fails on the new tables, adjust that test the same way Part 5 did (record it as a deviation).
- [ ] **Step 4: Run** the same command, then `pnpm test` — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "Add the activity log and sync-run storage"`

### Task 2: Log what goes in and out

**Files:**
- Modify: `apps/server/src/tokens.ts`, `apps/server/src/http.ts`, `apps/server/src/mcp.ts`
- Test: extend `apps/server/test/http.test.ts`, `apps/server/test/mcp.test.ts`, `apps/server/test/tokens.test.ts`

**Interfaces:**
- Consumes: `logActivity`, `forgetActivityForSession`, `forgetActivityForProject` (Task 1).
- Produces:
  - `Credential` bearer variant becomes `{ kind: 'bearer'; scope: Scope; id: number; label: string }`.
  - `actorFor(c: Credential): string` in `tokens.ts`: bearer `ingest` → `"your PC (<label>)"`, bearer `read` → `"read token: <label>"`, OAuth → the grant's client name (e.g. `"claude.ai"`). OAuth credentials gain `clientName` from the grant.
  - `McpCaller` gains `actor: string`.

Rules: `PUT /api/sessions/…` logs `in`/`upload` (project key, session ref `<source>:<id>`, detail = title cut to 100 chars) only when `changed` is true. `DELETE` of a session calls `forgetActivityForSession` then logs `in`/`delete` with the project key and no session ref; `DELETE` of a project calls `forgetActivityForProject` then logs `in`/`delete` with no project. Each MCP tool logs `out` after success: `list_projects` (no project), `get_project` (resolved key), `search` (project key if given; detail = query through `stripSecrets`, cut to 100 chars), `get_session` (session ref, its project key). `save_note` logs `in`/`note` (project key, session ref, detail = title).

- [ ] **Step 1: Write the failing tests:** an upload that changes something logs one row with actor `your PC (collector)` for a token labelled `collector`; an unchanged re-upload logs nothing; deleting a session removes its earlier rows and leaves one `delete` row without a session ref; deleting a project removes all its rows; each MCP tool logs its row with the right actor for a read token and for an OAuth grant; a search query containing a GitHub token is logged with `[REDACTED:github]`.
- [ ] **Step 2: Run** `…vitest run test/http.test.ts test/mcp.test.ts test/tokens.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.** A logging failure must never fail the request: wrap each `logActivity` call so an error is written to the server log and swallowed.
- [ ] **Step 4: Run** them, then `pnpm test` — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "Log uploads, deletes, notes and lookups in the activity log"`

### Task 3: The PC reports every sync run

**Files:**
- Modify: `apps/server/src/http.ts` (route `POST /api/sync-runs`), `apps/collector/src/upload.ts`, `apps/collector/src/sync.ts`, `apps/collector/src/cli.ts`
- Test: extend `apps/server/test/http.test.ts`, `apps/collector/test/sync.test.ts`, `apps/collector/test/cli.test.ts`

**Interfaces:**
- Consumes: `recordSyncRun` (Task 1).
- Produces: `POST /api/sync-runs` (scope `ingest`, JSON `{ finished_at, uploaded, unchanged, errors }`, all non-negative integers except the ISO time) → `204`; `reportSyncRun(remote, r): Promise<void>` in `upload.ts`.

- [ ] **Step 1: Write the failing tests:**
  - server: a read token → 403; bad body (negative or non-integer counts, missing `finished_at`) → 400; a valid report → 204 and `latestSyncRun` returns it.
  - collector: after a non-dry-run `runSync`, the fake server received exactly one report with the run's counts (`uploaded` = number of uploaded sessions, `errors` = `report.errors.length`); a dry run sends none; a scoped sync (`--project`) still reports.
  - cli: when the report request fails, `hub sync` still exits 0 for a successful sync and prints at most one line containing `could not report this run`.
- [ ] **Step 2: Run** the three test files — expect FAIL.
- [ ] **Step 3: Implement.** Send the report after `saveState`, with the same remote and a 10-second timeout.
- [ ] **Step 4: Run** them, then `pnpm test` — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "Report each hub sync run to the server"`

### Task 4: Browser sign-in

**Files:**
- Create: `apps/server/src/web/session.ts`, `apps/server/src/web/routes.ts`, `apps/server/src/web/html.ts` (only `escapeHtml`, `securityHeaders` and a minimal `signInPage` for now)
- Modify: `apps/server/src/http.ts` (mount `handleWeb` before the 404, remove the JSON landing), `apps/server/src/main.ts`
- Test: `apps/server/test/web-session.test.ts`; rewrite the landing tests in `apps/server/test/http.test.ts`

**Interfaces:**
- Consumes: `consumeConnectCode` (Part 5), `AuthLimiter`.
- Produces:
  - `interface WebConfig { imageTag: string | null; startedAt: string; digestsOn: boolean; backupStatusPath: string | null; secureCookies: boolean }`; `AppDeps.web?: WebConfig`.
  - `createWebSession(db, now): { cookie: string; csrf: string }`, `checkWebSession(db, cookieValue, now): { id: number; csrf: string } | null` (updates `last_used_at`), `revokeWebSession(db, id, now): boolean`, `listWebSessions(db): WebSessionRow[]`, `parseCookies(header): Record<string,string>`, `sessionCookie(value, secure): string`, `clearedCookie(secure): string`.
  - `handleWeb(req, res, path, method, ctx: WebCtx): Promise<boolean>` with `WebCtx = { db; cfg: WebConfig; limiter; address; now: () => string; readBody: () => Promise<Buffer> }`.

- [ ] **Step 1: Write the failing tests** (`web-session.test.ts`, over real HTTP):
  - `GET /` and `GET /projects/github.com%2Fme%2Falpha` without a cookie → `302` with `Location: /login`, and the body does not contain `alpha` (Review Focus 1).
  - `GET /login` → 200 page with a code field and the hint `Run hub connect on your PC to get one.`; it contains no project name.
  - A right code on `POST /login` → `302 /`, a `Set-Cookie` that is `HttpOnly`, `SameSite=Strict`, `Max-Age=2592000` (and `Secure` when `secureCookies`); then `GET /` with that cookie → 200.
  - A wrong code → 200 page with `That code is wrong or has expired.`; 10 wrong codes → the 11th → 429 page.
  - An expired session (31 days later) or a revoked one → `302 /login`.
  - A browser session cookie on `/mcp` or `/api/status` → 401 (not accepted there).
  - `POST /logout` with the right `csrf` clears the cookie and revokes the session; without it → 403.
  - `/healthz` still answers without a session.
- [ ] **Step 2: Run** `…vitest run test/web-session.test.ts test/http.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.** `main.ts` builds `web` from env: `IMAGE_TAG`, the process start time, whether `ANTHROPIC_API_KEY` is set, `BACKUP_STATUS_PATH` (default `/backup-status/context-hub.json` when it exists, else null), and `secureCookies` true unless `PUBLIC_URL` is unset or starts with `http://localhost`.
- [ ] **Step 4: Run** them, then `pnpm test` — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "Add browser sign-in with connect codes"`

### Task 5: Page shell, assets and safe Markdown

**Files:**
- Create: `apps/server/src/web/assets.ts`, `apps/server/src/web/markdown.ts`; extend `apps/server/src/web/html.ts`
- Test: `apps/server/test/web-markdown.test.ts`, `apps/server/test/web-shell.test.ts`

**Interfaces:**
- Produces: `renderMarkdown(md: string): string`; `pageShell(o: { title: string; active: 'overview' | 'activity' | 'projects' | 'sign-ins'; csrf: string; body: string }): string` (sidebar with the four links and Sign out form, header with the theme switch and phone menu button, links to `/assets/app.css` and `/assets/app.js`); `GET /assets/app.css` and `/assets/app.js` with long-lived caching.

`renderMarkdown` escapes first, then supports only: `#`–`####` headings, paragraphs, `-`/`*` lists (one level), `**bold**`, `` `code` ``, and `[text](url)` links where the URL starts with `https://` or `http://` (rendered with `rel="noopener noreferrer"`); any other link renders as its text only.

- [ ] **Step 1: Write the failing tests:**
  - markdown: headings, lists, bold, code and an `https` link render as expected; `<script>alert(1)</script>` and `<img src=x onerror=alert(1)>` come out escaped; `[x](javascript:alert(1))` and `[x](data:text/html,…)` render as plain `x` with no `<a` (Review Focus 4).
  - shell: a signed-in page has the CSP header exactly as in Global Constraints, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, no inline `<script>` content and no `style=` attribute; the sidebar marks the active page; `app.css` defines both themes' custom properties with the colours from Global Constraints; `app.js` reads and writes `localStorage` `hub-theme` inside try/catch and rewrites `<time>` elements.
- [ ] **Step 2: Run** the two test files — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** them, then `pnpm test` — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "Add the dashboard shell, styles and safe Markdown"`

### Task 6: Health and the Overview page

**Files:**
- Create: `apps/server/src/web/health.ts`, `apps/server/src/web/backup-status.ts`; extend `apps/server/src/web/pages.ts` and `routes.ts`
- Test: `apps/server/test/web-health.test.ts`, `apps/server/test/web-overview.test.ts`

**Interfaces:**
- Consumes: `status`, `digestCounts` and the digest rows (existing), `state_retries`, `latestSyncRun`, `listActivity` (Task 1).
- Produces:
  - `readBackupStatus(path: string | null): BackupStatus | null` where `BackupStatus = { finished_at: string; local_ok: boolean; size_bytes: number | null; offsite_configured: boolean; offsite_ok: boolean | null }`; an unreadable or invalid file → null.
  - `computeHealth(db, cfg: WebConfig, now: string): Health` where `Health = { healthy: boolean; problems: Problem[]; notices: Problem[]; cards: { projects; sessions; lastSync: SyncRun | null; lastBackup: BackupStatus | null } }` and `Problem = { kind: string; text: string; ref?: string }`.

Problem rules (from spec 3.2): each failed digest; each `state_retries` row; summaries off (`digestsOn` false) when any digest is pending; a pending digest older than 1 hour while summaries are on; latest sync run with `errors > 0` or none for more than 3 days (no report at all and the server started more than 3 days ago also counts); backup status missing for more than 26 hours after `startedAt`, older than 26 hours, `local_ok` false, or `offsite_configured && offsite_ok === false`. Refused digests go in `notices` (shown, marked "won't be retried until the session changes"), never in `problems`. `healthy = problems.length === 0`.

- [ ] **Step 1: Write the failing tests:** one test per problem rule above, each starting from a healthy fixture and changing one thing; a refused digest leaves `healthy` true and appears in `notices`; `readBackupStatus` returns null for a missing file and for invalid JSON. Overview page: shows the five cards, `Healthy` or `Needs attention`, the Problems box only when there are problems, the latest 10 activity rows, and `running <imageTag>`.
- [ ] **Step 2: Run** the two test files — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** them, then `pnpm test` — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "Add health checks and the Overview page"`

### Task 7: Activity and Projects pages

**Files:**
- Modify: `apps/server/src/web/pages.ts`, `apps/server/src/web/routes.ts`
- Test: `apps/server/test/web-pages.test.ts`

**Interfaces:**
- Consumes: `listActivity` (Task 1); `listProjects`, `resolveProject`, `getProject` (existing); `renderMarkdown` (Task 5).

- [ ] **Step 1: Write the failing tests:**
  - Activity: 120 rows → page 1 shows the newest 50 with a link to page 2; `?direction=out` shows only reads; each row shows time, direction, action, project and actor; consecutive `upload` rows for the same project and actor within 2 minutes show as one row ("2 sessions").
  - Projects: lists every project with session count and summary, linking to `/projects/<encodeURIComponent(key)>`.
  - Project detail: `/projects/` + `encodeURIComponent('github.com/abdulmuhg/jsonroom')` shows the rendered state page and the recent sessions and notes with their source and digest status (Review Focus 3); an unknown key → 404 page "No such project"; a title `<img src=x onerror=alert(1)>` renders escaped (Review Focus 4).
- [ ] **Step 2: Run** `…vitest run test/web-pages.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** it, then `pnpm test` — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "Add the Activity and Projects pages"`

### Task 8: Sign-ins page and Disconnect

**Files:**
- Modify: `apps/server/src/web/pages.ts`, `apps/server/src/web/routes.ts`
- Test: `apps/server/test/web-signins.test.ts`

**Interfaces:**
- Consumes: `listGrants`, `revokeGrant` (Part 5); `listTokens`, `revokeToken` (existing); `listWebSessions`, `revokeWebSession` (Task 4).
- Produces: `POST /sign-ins/disconnect` with fields `csrf`, `kind` (`grant` | `token` | `browser`), `id`, `confirm` (`yes` on the second step).

Flow: the first POST (no `confirm`) renders a confirmation page naming the consequence: for an `ingest` token, `Your PC's hub sync will stop working until you create a new upload token on the server.`; for a `read` token, `Assistants using this token (for example Claude Code) will lose access to the hub.`; for a grant, `<client> will need to sign in again.`; for the current browser, `This signs this browser out.`; with Disconnect and Cancel buttons. The second POST (`confirm=yes`) revokes and redirects to `/sign-ins` (or `/login` for the current browser). Requests whose `Origin` header is present and not the configured public origin get `403`.

- [ ] **Step 1: Write the failing tests:** the page lists grants, tokens and browsers with signed-in/created and last-used times and marks `this browser`; revoked entries show greyed with the revoked time and no button; the two-step disconnect for each kind, with the exact consequence texts above (Review Focus 5); disconnecting the current browser ends on `/login` and the old cookie no longer works; a POST without `csrf`, with a wrong `csrf`, or with `Origin: https://evil.example` → 403 and nothing revoked (Review Focus 2); no token value or hash appears anywhere on the page.
- [ ] **Step 2: Run** `…vitest run test/web-signins.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** it, then `pnpm test` and `pnpm typecheck` — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "Add the Sign-ins page with confirmed Disconnect"`

### Task 9: Backup status, docs, deploy and the real test

**Files:**
- Modify: `~/project/vps-stack/scripts/backup-context-hub.sh` (write the status file), `~/project/vps-stack/context-hub/docker-compose.yml` (mount `/opt/stack/backups/status:/backup-status:ro`), `~/project/vps-stack/README.md`; `README.md` in context-hub ("The dashboard" section: sign in with `hub connect`, what each page shows, rebuild the `hub` command once for sync reports).

Status file: `/opt/stack/backups/status/context-hub.json`, written atomically (write to a temp file in the same folder, then `mv`), on success and on failure (use a `trap` so a failing step still writes `local_ok: false`), with the fields of `BackupStatus` (Task 6). `offsite_configured` is true when `S3_BUCKET` is set; `offsite_ok` is null when not configured.

- [ ] **Step 1:** Make the vps-stack changes and the context-hub README section. Commit each repo: `git commit -m "Write a backup status file and mount it into context-hub"` and `git commit -m "Document the dashboard"`. Do not push or touch the server (owner and reviewer do that).
- [ ] **Step 2 (reviewer and owner):** Push vps-stack, pull on the server, run the backup script once by hand and check the status file; recreate the context-hub container so the mount applies (`docker compose up -d`). Merge the dashboard to `main` and push (deploys). Rebuild the collector on the PC.
- [ ] **Step 3 (owner, manual):** Open `https://hub.abdulmughnialfikri.com/` on desktop and phone: sign in with a `hub connect` code; check Overview (healthy, last sync, last backup with off-site, running version), Activity after a `hub sync` and a claude.ai question, a project's briefing, and Sign-ins; switch themes; disconnect and re-create nothing important (try it on the browser session itself).
- [ ] **Step 4:** Record results and deviations in `docs/superpowers/plans/dashboard-deviations.md` and commit.
