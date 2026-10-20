# context-hub New-Computer Setup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect a new computer to a hub with `curl -fsSL <hub>/install | sh` and `hub login` plus one code from the dashboard.

**Architecture:** Connect codes gain a purpose (`signin` | `device`). The dashboard's Sign-ins page issues either kind. A new unauthenticated `POST /api/devices` swaps a device code for a named upload token. The server image carries the collector's single-file bundle and serves it at `/hub.mjs` with a generated install script at `/install`. The collector gains `hub login` and `hub install-commands`.

**Tech Stack:** TypeScript (NodeNext ESM), Node 22, better-sqlite3, tsup, vitest, POSIX sh. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-20-context-hub-device-setup-design.md`.

## Global Constraints

- Codes: purpose `signin` or `device`; 10 minutes, one use, stored hashed; a code works only for its own purpose. Existing callers (`hub connect`, `hub-admin connect-code`, `/oauth/authorize`, `/login`) use `signin` and behave exactly as before.
- `POST /api/devices` body JSON `{ "code": string, "name": string }`. Success `200 { "token": string, "label": string }` with `Cache-Control: no-store`. Wrong, used or expired code `401 { "error": "That code is wrong or has expired." }` and `limiter.recordFailure(address)`; a blocked address gets `429` before the code is read. Bad body `400`.
- Computer name: keep only `[A-Za-z0-9 ._-]`, trim, cut to 40 characters; empty becomes `computer`. The token label is that name; scope `ingest`.
- `GET /install` and `GET /hub.mjs` need no session and answer `404` when `PUBLIC_URL` is unset. `/install`: `Content-Type: text/x-shellscript; charset=utf-8`. `/hub.mjs`: `Content-Type: text/javascript; charset=utf-8`, read once at startup from `CLIENT_BUNDLE_PATH` (default `/app/client/hub.mjs`); `404` if the file is missing. Both `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.
- Installer paths: bundle `${XDG_DATA_HOME:-$HOME/.local/share}/context-hub/hub.mjs`; launcher `$HOME/.local/bin/hub` (`#!/bin/sh` then `exec node "<bundle>" "$@"`). It never touches `~/.context-hub`.
- Node 22 or newer is required by the installer; older or missing Node stops with a one-line message naming the version found and `https://nodejs.org`.
- Dashboard forms keep the existing csrf and Origin checks. Codes are shown only on the page that created them, never stored readable.
- Commits carry no Co-Authored-By or other attribution trailers. One new migration only (index 5, `user_version` 6); never edit an existing migration. All existing tests keep passing.

## Review Focus

1. **A code used for the wrong purpose:** a device code on `/login`, `/oauth/authorize` or `hub connect`'s path, or a sign-in code on `/api/devices`, is refused and stays usable for its real purpose. Test in Task 1 and Task 3.
2. **Guessing at `/api/devices`:** ten wrong codes block the address; a right code from another address still works. Test in Task 3.
3. **A hostile computer name** (`<img src=x onerror=alert(1)>`, 500 characters, only symbols) becomes a safe, short label and shows escaped on Sign-ins. Test in Task 3.
4. **Running the installer twice** updates the bundle and launcher in place and leaves `~/.context-hub/config.json` and `credentials` untouched. Test in Task 6 (run the script against a temp `HOME` with a fake `curl` on `PATH`).
5. **`hub login` against a different hub than the saved one** asks before replacing, and a failed exchange saves nothing. Test in Task 5.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/server/src/db.ts` (modify) | Migration 6: `connect_codes.purpose` |
| `apps/server/src/oauth/store.ts` (modify) | `createConnectCode` / `consumeConnectCode` take a purpose |
| `apps/server/src/devices.ts` (create) | `cleanDeviceName`, `exchangeDeviceCode` |
| `apps/server/src/http.ts` (modify) | `POST /api/devices`; route `/install` and `/hub.mjs` |
| `apps/server/src/client-dist.ts` (create) | Load the bundle; build the install script |
| `apps/server/src/web/pages.ts`, `routes.ts` (modify) | Sign-ins buttons and the code page |
| `apps/server/src/main.ts` (modify) | Load the bundle path |
| `Dockerfile` (modify) | Build the collector and copy its bundle into the image |
| `apps/collector/src/commands.ts` (create) | The five slash command texts |
| `apps/collector/src/cli.ts`, `upload.ts` (modify) | `hub login`, `hub install-commands` |
| `README.md` (modify) | "Upload this computer's sessions" uses the new setup |

---

### Task 1: Code purposes

**Files:** Modify `apps/server/src/db.ts`, `apps/server/src/oauth/store.ts`. Test: extend `apps/server/test/oauth-store.test.ts`, `apps/server/test/db.test.ts`.

**Interfaces:**
- Produces: `type CodePurpose = 'signin' | 'device'`; `createConnectCode(db, now, purpose: CodePurpose = 'signin')`; `consumeConnectCode(db, input, now, purpose: CodePurpose = 'signin'): boolean` — a code of the other purpose returns false and is **not** marked used.

- [ ] **Step 1: Write the failing tests:** a device code consumed as `signin` returns false and then works as `device`; a sign-in code consumed as `device` returns false and then works as `signin`; existing rows (created before the migration) are `signin`. `db.test.ts`: `SCHEMA_VERSION` is 6 and `connect_codes` has `purpose`.
- [ ] **Step 2: Run** `pnpm --filter ./apps/server exec vitest run test/oauth-store.test.ts test/db.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.** Migration 6: `ALTER TABLE connect_codes ADD COLUMN purpose TEXT NOT NULL DEFAULT 'signin' CHECK (purpose IN ('signin','device'))`. Adjust any test that replays migrations, as earlier parts did, and log it.
- [ ] **Step 4: Run** the same command, then `pnpm test` — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "Give one-time codes a purpose: sign-in or device"`

### Task 2: Codes from the dashboard

**Files:** Modify `apps/server/src/web/pages.ts`, `apps/server/src/web/routes.ts`. Test: extend `apps/server/test/web-signins.test.ts`.

**Interfaces:**
- Consumes: `createConnectCode` (Task 1); `actionAllowed` (existing).
- Produces: `POST /sign-ins/code` with fields `csrf`, `purpose` (`signin` | `device`) → `200` code page; any other `purpose` → `400` page.

The Sign-ins page gets, under its intro, two buttons in one form row: **Add a computer** (`purpose=device`) and **New sign-in code** (`purpose=signin`). The code page shows the code large (Inter, 28 px, letter-spaced), "Valid for 10 minutes, for one use.", and:
- for `device`: `Run these on the new computer:` then two copyable lines, `curl -fsSL <PUBLIC_URL>/install | sh` and `hub login`, and `Enter this code when hub login asks for it.` When `PUBLIC_URL` is unset, show only `hub login --url <this hub's address>` guidance text without the curl line.
- for `signin`: `Enter it where claude.ai or another browser asks for a sign-in code.`
- a link back to Sign-ins.

- [ ] **Step 1: Write the failing tests:** both buttons render with the csrf field; a valid POST for each purpose shows a code matching `^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$` and stores one code of that purpose; the device page contains the exact curl line with the configured public origin; no csrf or a foreign `Origin` → 403 and no code stored; `purpose=admin` → 400 and no code stored.
- [ ] **Step 2: Run** `…vitest run test/web-signins.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.** The page sets `Cache-Control: no-store` (already the default for pages).
- [ ] **Step 4: Run** it, then `pnpm test` — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "Issue sign-in and device codes from the Sign-ins page"`

### Task 3: Swap a device code for an upload token

**Files:** Create `apps/server/src/devices.ts`; modify `apps/server/src/http.ts`. Test: `apps/server/test/devices.test.ts`.

**Interfaces:**
- Consumes: `consumeConnectCode(…, 'device')` (Task 1); `createToken` (existing).
- Produces: `cleanDeviceName(raw: unknown): string`; `exchangeDeviceCode(db, input: { code: string; name: string }, now): { token: string; label: string } | null`; route `POST /api/devices` per Global Constraints.

- [ ] **Step 1: Write the failing tests:** a valid device code and name `abdul-macbook` → 200 with a `chub_` token and label `abdul-macbook`; that token then uploads a session (`PUT /api/sessions/…` → 200); the token is listed with scope `ingest`; the same code a second time → 401; a sign-in code → 401 and still usable on `/login` (Review Focus 1); 10 wrong codes → the 11th → 429, and a right code from another `X-Forwarded-For` → 200 (Review Focus 2); `cleanDeviceName` maps `<img src=x onerror=alert(1)>` to `img srcx onerroralert1` (or another safe string with no `<>=()`), cuts a 500-character name to 40, maps `"!!!"` and a non-string to `computer`; the Sign-ins page shows the label escaped (Review Focus 3); a non-JSON body → 400; the success response has `Cache-Control: no-store`.
- [ ] **Step 2: Run** `…vitest run test/devices.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** it, then `pnpm test` — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "Let a device code be swapped for a named upload token"`

### Task 4: Slash commands carried by the `hub` command

**Files:** Create `apps/collector/src/commands.ts`; modify `apps/collector/src/cli.ts`. Test: extend `apps/collector/test/cli.test.ts`; create `apps/collector/test/commands.test.ts`.

**Interfaces:**
- Produces: `export const SLASH_COMMANDS: Record<string, string>` keyed by file name (`hub-sync.md`, `hub-catchup.md`, `hub-note.md`, `hub-status.md`, `hub-track.md`), values the exact current file contents; `hub install-commands [--dir <path>]` (default `~/.claude/commands`) writes them and prints `Installed 5 slash commands in <dir>.`

- [ ] **Step 1: Write the failing tests:** `commands.test.ts` reads each `integrations/claude-code/*.md` and asserts it equals `SLASH_COMMANDS[name]`, and that there are exactly five; `cli.test.ts`: `hub install-commands --dir <tmp>` creates the five files with those contents, and running it again overwrites without error.
- [ ] **Step 2: Run** `pnpm --filter ./apps/collector exec vitest run test/commands.test.ts test/cli.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.** Add `install-commands` to the usage text.
- [ ] **Step 4: Run** them, then `pnpm test` — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "Carry the slash commands in hub and add hub install-commands"`

### Task 5: `hub login`

**Files:** Modify `apps/collector/src/cli.ts`, `apps/collector/src/upload.ts`. Test: extend `apps/collector/test/cli.test.ts`.

**Interfaces:**
- Consumes: `POST /api/devices` (Task 3); `saveToken`, config `server_url` (existing).
- Produces: `exchangeDeviceCode(url: string, code: string, name: string, fetchImpl?): Promise<{ token: string; label: string }>` in `upload.ts` (throws with the server's error text on 401/429); `hub login [--url <address>] [--name <name>]`.

Flow: address = `--url`, else saved `server_url`, else ask `Hub address (https://...): `. If a saved `server_url` exists and differs from `--url`, ask `This computer is connected to <saved>. Replace it with <new>? (y/N) ` and stop on anything but `y`. Name = `--name`, else ask `Name for this computer [<hostname>]: ` (empty answer keeps the host name). Code = ask `Code from the dashboard (Sign-ins > Add a computer): `. On success save `server_url` and the token, then print `Connected as "<label>". Next: hub projects, then hub track <project> and hub sync.` On failure print the server's message and save nothing.

- [ ] **Step 1: Write the failing tests** (fake server): a fresh login saves the address and token and prints the label; a 401 saves nothing and prints `That code is wrong or has expired.`; a different saved hub with answer `n` stops before asking for the code (Review Focus 5); the name prompt defaults to the host name; the token never appears in output.
- [ ] **Step 2: Run** `…vitest run test/cli.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.** Add `login` to the usage text.
- [ ] **Step 4: Run** it, then `pnpm test` — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "Add hub login: connect a computer with a dashboard code"`

### Task 6: Serve the client and the installer

**Files:** Create `apps/server/src/client-dist.ts`; modify `apps/server/src/http.ts`, `apps/server/src/main.ts`, `Dockerfile`. Test: `apps/server/test/client-dist.test.ts`.

**Interfaces:**
- Produces: `loadClientBundle(path: string): string | null`; `installScript(publicUrl: string): string`; `AppDeps.client?: { bundle: string | null }`; routes `GET /install`, `GET /hub.mjs` per Global Constraints.

The script, in order: `set -eu`; check `command -v node` and major version ≥ 22, else print `context-hub needs Node 22 or newer (found: <version or none>). Get it from https://nodejs.org.` and exit 1; create the data dir and `$HOME/.local/bin`; download `<PUBLIC_URL>/hub.mjs` with `curl -fsSL` to a temp file in the data dir, then `mv` it over `hub.mjs`; write the launcher and `chmod +x`; if `$HOME/.local/bin` is not on `PATH`, print the line to add to the shell profile; run `"$HOME/.local/bin/hub" install-commands`; print `Installed. Next: hub login --url <PUBLIC_URL>`. The URL is inserted single-quoted.

- [ ] **Step 1: Write the failing tests:** `/install` and `/hub.mjs` → 404 without `PUBLIC_URL`; with it, `/install` contains `set -eu`, `'https://hub.test/hub.mjs'` and `hub login --url 'https://hub.test'`; `/hub.mjs` serves the configured bundle text and 404s when the bundle is null. Review Focus 4: run the script with `sh` against a temp `HOME`, a `PATH` holding a fake `curl` (writes a stub bundle) and the real `node`, twice; both runs exit 0, the launcher and bundle exist, the slash commands are installed (the stub bundle's `install-commands` can be a no-op that records it ran), and a pre-written `~/.context-hub/config.json` is byte-identical afterwards. Skip that one test on Windows (`it.skipIf(process.platform === 'win32')`).
- [ ] **Step 2: Run** `…vitest run test/client-dist.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.** Dockerfile build stage: `RUN pnpm --filter @context-hub/collector build` and copy `apps/collector/dist/bin.js` to `/runtime/client/hub.mjs`; runtime stage: `COPY --from=build /runtime/client ./client`. `main.ts` loads `CLIENT_BUNDLE_PATH` (default `/app/client/hub.mjs`) and logs `client bundle: on` or `off`.
- [ ] **Step 4: Run** it, then `pnpm test` and `pnpm typecheck` — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "Serve the hub command and an install script"`

### Task 7: Docs, deploy and the Mac test

**Files:** Modify `README.md` ("Upload this computer's sessions": macOS and Linux use the two commands and a code from Sign-ins > Add a computer; Windows keeps the manual steps; mention `hub install-commands`; drop the "planned" note).

- [ ] **Step 1:** Update the README and commit `git commit -m "Document the two-command setup"`. Do not push.
- [ ] **Step 2 (reviewer and owner):** merge to `main`, push (deploys), check `curl -s <hub>/install | head` and the log line `client bundle: on`.
- [ ] **Step 3 (owner, on the Mac):** dashboard > Sign-ins > Add a computer; run the two commands; `hub projects`, `hub track <project>`, `hub sync`; confirm the new token on Sign-ins and the sync on Overview; confirm `/hub-sync` exists in Claude Code.
- [ ] **Step 4:** Record results and deviations in `docs/superpowers/plans/device-setup-deviations.md` and commit.
