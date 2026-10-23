# Fresh Install Journey Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new computer goes from nothing to connected and syncing by pasting one line from **Sign-ins → Add a computer**, on macOS, Linux and Windows.

**Architecture:** The sh and PowerShell installers stay thin: they check Node, install the bundle and launcher, fix PATH, then call a new `hub setup` command. `hub setup` (TypeScript, tested through the existing `Io` fakes) connects, installs slash commands, turns on auto sync, prints a ✓/!/✗ checklist, asks which projects to upload and runs the first sync in the foreground. The server gains token retirement on re-paste, the token's label in `/api/status`, `/install.ps1`, and the two pasteable lines on the code page.

**Tech Stack:** TypeScript (Node 22, ESM), tsup, vitest, POSIX sh, Windows PowerShell 5.1.

**Spec:** `docs/superpowers/specs/2026-10-22-context-hub-fresh-install-design.md`

## Global Constraints

- Node 22 or newer is required. The installers never install Node.
- The PowerShell installer runs in Windows PowerShell 5.1: no `&&`, `||`, `??`, ternaries or other PowerShell 7 syntax. It must not need the execution policy changed, and it must never call `exit`, because it runs inside the user's session through `iex`.
- The one-time code never appears in a URL or a server log. `/install` and `/install.ps1` take no query string.
- No new runtime dependencies in the collector bundle.
- `hub login` (with and without prompts), `hub install-commands` and `hub auto on|off|status` keep their behaviour, with one deliberate change: `hub auto off` removes every context-hub hook, not only the one pointing at this bundle. There must only ever be one, and two would start two syncs.
- Every user-facing failure says what happened and the one thing to do next. No stack traces or raw HTTP codes on screen.
- Mac/Linux line: `curl -fsSL <HUB>/install | sh -s -- --code <CODE>`
- Windows line: `$env:HUB_CODE='<CODE>'; irm <HUB>/install.ps1 | iex`
- Paths: macOS/Linux bundle `${XDG_DATA_HOME:-$HOME/.local/share}/context-hub/hub.mjs`, launcher `~/.local/bin/hub`. Windows bundle `%LOCALAPPDATA%\context-hub\hub.mjs`, launcher `%LOCALAPPDATA%\context-hub\bin\hub.cmd`.
- The version is `YYYY.MM.DD-<7-char sha>` from the deploy build, and `dev` otherwise.
- The repo's commit messages carry no Co-Authored-By or other attribution trailers.
- Run tests with `pnpm vitest run <file>`. Before each commit, `pnpm typecheck` must be clean.

## Review Focus

1. **A code pasted more than 10 minutes after it was made**, for example after installing Node first. The user expects the "didn't work … get a new line" message and nothing half-saved (Task 4 test `an expired code saves nothing and says how to get a new line`).
2. **A re-paste without a code on a computer that was disconnected on the dashboard.** The user expects "This computer was disconnected …", not "Already connected" (Task 6 test `a revoked token without a code says the computer was disconnected`).
3. **A `~/.claude/settings.json` that isn't valid JSON.** Setup must still connect and finish, with the auto-sync row a warning (Task 6 test `a broken settings.json warns on the auto row and setup still succeeds`).
4. **A home folder with spaces** (`C:\Users\John Smith`). The launcher, the hook command and the PATH entry must all still work (Task 5 test `recognises a hook whose paths contain spaces`, Task 9 test `quotes a LOCALAPPDATA with spaces in hub.cmd`).
5. **No terminal to ask in** (no `/dev/tty`, or run from a script). Setup must skip picking, print the next step and exit 0 (Task 7 test `without a terminal it picks nothing and says how to choose later`, Task 8 test `runs setup without /dev/tty when there is none`).

---

### Task 1: Version stamp and `hub --version`

**Files:**
- Create: `apps/collector/src/version.ts`
- Modify: `apps/collector/tsup.config.ts`, `apps/collector/src/cli.ts` (dispatch), `Dockerfile` (collector build step), `.github/workflows/deploy.yml` (build-push step)
- Test: `apps/collector/test/cli.test.ts`

**Interfaces:**
- Produces: `export const HUB_VERSION: string` from `apps/collector/src/version.ts`.

- [ ] **Step 1: Write the failing test** `hub --version prints the version`:
  `expect(await run(['--version'], io)).toBe(0); expect(out).toEqual([HUB_VERSION]);` and `expect(HUB_VERSION).toBe('dev')`, since tests run unbundled.
- [ ] **Step 2: Run it and confirm it fails.** Run `pnpm vitest run apps/collector/test/cli.test.ts -t "version"`. Expected: FAIL (unknown command, USAGE).
- [ ] **Step 3: Implement the version.**
  - In `version.ts`: `declare const __HUB_VERSION__: string | undefined;` and `export const HUB_VERSION = typeof __HUB_VERSION__ === 'string' ? __HUB_VERSION__ : 'dev';`.
  - In tsup: `define: { __HUB_VERSION__: JSON.stringify(process.env.HUB_VERSION ?? 'dev') }`.
  - Add `case '--version'` to dispatch.
  - In the Dockerfile: `ARG HUB_VERSION=dev`, then `RUN HUB_VERSION=$HUB_VERSION pnpm --filter @context-hub/collector build`.
  - In deploy.yml: add a `version` output in the `meta` step, `echo "version=$(date -u +%Y.%m.%d)-${GITHUB_SHA::7}" >> "$GITHUB_OUTPUT"`, and pass `build-args: HUB_VERSION=${{ steps.meta.outputs.version }}`.
- [ ] **Step 4: Run the test and confirm it passes.** Also run `HUB_VERSION=2026.10.23-abc1234 pnpm --filter @context-hub/collector build && node apps/collector/dist/bin.js --version`. Expected: `2026.10.23-abc1234`.
- [ ] **Step 5: Commit.** `git commit -m "Stamp the hub bundle with a version, shown by hub --version"`

### Task 2: Server: retire the old token on re-paste, and name the token in /api/status

**Files:**
- Modify: `apps/server/src/devices.ts`, `apps/server/src/http.ts` (the `/api/devices` and `/api/status` routes)
- Test: `apps/server/test/devices.test.ts`, the existing HTTP test file that covers `/api/status`

**Interfaces:**
- Produces: `exchangeDeviceCode(db, input: { code: string; name: string; retire?: string }, now: string): { token: string; label: string } | null`.
- Produces: `POST /api/devices` reads an optional `Authorization: Bearer <old token>` and passes it as `retire`.
- Produces: `GET /api/status` adds `label: string`, the token's label, when the caller used a bearer token.

- [ ] **Step 1: Write the failing tests.**
  - `retires the token it was given once the new one is issued`: create an ingest token, exchange a valid code with `retire` set to it, then `verifyToken(db, old, now)` is `null` and the new token verifies.
  - `a wrong code retires nothing`: with a bad code the result is `null` and the old token still verifies.
  - `an unknown or read-scope retire token is ignored`: the exchange succeeds and a read token is not revoked.
  - HTTP: `/api/devices with a bearer retires it`, and `/api/status names the token's label`: `expect(body.label).toBe('my-mac')`.
- [ ] **Step 2: Run them and confirm they fail.** Run `pnpm vitest run apps/server/test/devices.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the retirement.**
  - Inside the existing transaction, after `consumeConnectCode` succeeds: when `retire` is given, look the token up by hash. Only an unrevoked **ingest** token gets `revokeToken`.
  - In the route, parse the header with the same `^Bearer\s+(\S+)$` regex `authorise` uses. Never call `authorise` there: the route stays unauthenticated.
  - In `/api/status`, keep the `Credential` that `authorise` returns and add `label` when `kind === 'bearer'`.
- [ ] **Step 4: Run them and confirm they pass,** along with `pnpm vitest run apps/server/test`.
- [ ] **Step 5: Commit.** `git commit -m "Retire a computer's old token when it pastes a new code, and name the token in status"`

### Task 3: Collector: clear errors everywhere

**Files:**
- Create: `apps/collector/src/errors.ts`
- Modify: `apps/collector/src/upload.ts` (`request`, `send`, `exchangeDeviceCode`), `apps/collector/src/cli.ts` (move `Fail` out, and `run`)
- Test: `apps/collector/test/errors.test.ts`, `apps/collector/test/cli.test.ts`

**Interfaces:**
- Produces, in `errors.ts`:
  - `export class Fail extends Error {}`, moved from cli.ts. cli.ts imports it.
  - `export class UnreachableError extends Error { constructor(readonly url: string, readonly reason: string) }`, with the message `could not reach ${url}: ${reason}`, unchanged so that existing message checks still match.
  - `export class HttpStatusError extends Error { constructor(readonly method: string, readonly path: string, readonly status: number) }`, with the message `${method} ${path}: server answered ${status}`, unchanged.
  - `export class BadCodeError extends Error {}`
  - `export function plainReason(e: unknown): string`
  - `export function friendlyMessage(e: unknown, hubDir: string, now?: Date): string`. For unexpected errors it appends the stack to `<hubDir>/error.log` and names that path.
- Produces, in `upload.ts`: `request` throws `UnreachableError(base, plainReason(e))`; `send` throws `HttpStatusError`; `exchangeDeviceCode` throws `UnreachableError`, `BadCodeError` on 401, and `HttpStatusError` otherwise.

- [ ] **Step 1: Write the failing tests** in `errors.test.ts`:
  - `plainReason` maps by `cause.code`:
    - `ENOTFOUND` and `EAI_AGAIN` → `"the address wasn't found"`
    - `ECONNREFUSED` → `"the connection was refused"`
    - `ECONNRESET` → `"the connection was dropped"`
    - an error named `TimeoutError` or `AbortError` → `"it didn't answer in time"`
    - codes starting `CERT_`, `ERR_TLS`, `UNABLE_TO_VERIFY`, `SELF_SIGNED`, `DEPTH_ZERO` → `"its certificate couldn't be checked"`
    - anything else → the error's message
  - `friendlyMessage` text:
    - `BadCodeError` → `That code didn't work: it has expired, was already used, or was mistyped. Get a new line from Sign-ins → Add a computer and paste it.`
    - `UnreachableError('https://hub.test', 'the address wasn't found')` → `Can't reach https://hub.test (the address wasn't found). Check your internet connection and the address, then try again.`
    - `HttpStatusError` with 401 or 403 → `This computer was disconnected from the hub. Get a new line from Sign-ins → Add a computer and paste it.`
    - a `Fail` → its own message
    - a plain `TypeError('boom')` → `Something went wrong: boom. Details are in <hubDir>/error.log`, and the log holds the stack.
  - In cli.test, update `prints the server message on a wrong code and saves nothing` to expect the BadCodeError text.
- [ ] **Step 2: Run them and confirm they fail.** Run `pnpm vitest run apps/collector/test/errors.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement the errors.** `run()` catches and prints `friendlyMessage(e, io.hubDir)`. Writing the log must never throw.
- [ ] **Step 4: Run them and confirm they pass,** along with `pnpm vitest run apps/collector/test`. The existing `/answered 40[13]/` check in doctor must still pass.
- [ ] **Step 5: Commit.** `git commit -m "Say what went wrong and what to do, for every collector failure"`

### Task 4: Remember the computer's name, and retire the old token from login

**Files:**
- Modify: `apps/collector/src/config.ts` (`Config`), `apps/collector/src/upload.ts` (`exchangeDeviceCode`, `HubStatus`), `apps/collector/src/cli.ts` (`login`), `apps/collector/src/sync.ts:541`
- Test: `apps/collector/test/cli.test.ts`, `apps/collector/test/sync.test.ts`

**Interfaces:**
- Produces: `Config.label?: string` (the hub's name for this computer) and `Config.setup_version?: string` (written by Task 6).
- Produces: `exchangeDeviceCode(url, code, name, fetchImpl?, retireToken?: string)`, which sends `Authorization: Bearer <retireToken>` when given.
- Produces: `HubStatus.label?: string`.
- Produces: an exported `connectWithCode(io: Io, url: string, code: string, name: string): Promise<{ label: string; previousUrl: string | null }>` in cli.ts. Both `login` and `setup` use it. It sends the saved token as `retireToken` only when the saved `server_url` equals `url`, then saves `server_url`, the token and `label`.

- [ ] **Step 1: Write the failing tests.**
  - `login stores the label the hub returns`: `expect(loadConfig(io.hubDir).label).toBe('my-mac')`.
  - `login on the same hub sends the old token to retire it`: the request headers carry `authorization: Bearer old`.
  - `login to a different hub sends no old token`.
  - `an expired code saves nothing and says how to get a new line` (Review Focus 1).
  - sync.test: `the Git section names the stored label`. With `label: 'MRC'` in the config and no `opts.computer`, the git check's `computer` is `'MRC'`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement it.** In `login`, replace the inline exchange with `connectWithCode`. In sync.ts use `opts.computer ?? s.cfg.label ?? hostname()`.
- [ ] **Step 4: Run them and confirm they pass,** along with the whole collector suite.
- [ ] **Step 5: Commit.** `git commit -m "Remember the hub's name for this computer, and retire its old token on login"`

### Task 5: Recognise our auto-sync hook by its shape, and repoint it

**Files:**
- Modify: `apps/collector/src/auto.ts`
- Test: `apps/collector/test/auto.test.ts`

**Interfaces:**
- Produces: `export function isOurHook(command: unknown): boolean`. This replaces the private `isOurs`. It is true for `/^"[^"]+" "[^"]+" sync --auto$/`, whatever the paths are.
- Produces: `export function repointHook(settingsPath: string, command: string): { repointed: number }`. It rewrites every hook of ours to `command`, keeps only one, and writes nothing when nothing changes.
- Changes: `autoOn(settingsPath, command)` now repoints an existing hook of ours (`changed` is true only when the text changed) instead of adding a second one. `autoOff(settingsPath)` drops the `bundleName` parameter and removes every hook of ours. Update its one caller in cli.ts.

- [ ] **Step 1: Write the failing tests.**
  - `autoOn over a hook pointing at an old clone repoints it instead of adding a second`: start with `"C:\\node.exe" "C:\\src\\context-hub\\apps\\collector\\dist\\bin.js" sync --auto`; after `autoOn` with the new bundle there is exactly one SessionEnd hook, holding the new command.
  - `repointHook leaves settings untouched when there is no hook of ours`: the file's bytes are unchanged and there is no `.hub-backup`.
  - `repointHook collapses two of our hooks into one`.
  - `recognises a hook whose paths contain spaces` (Review Focus 4): `"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\John Smith\\AppData\\Local\\context-hub\\hub.mjs" sync --auto`.
  - `other people's hooks are never touched`: a hook `echo sync --auto` is kept by `autoOff` and `repointHook`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement it,** reusing `readSettings`, `sessionEnd` and `writeSettings`.
- [ ] **Step 4: Run them and confirm they pass,** along with `cli.test.ts` (auto on/off/status).
- [ ] **Step 5: Commit.** `git commit -m "Recognise the auto-sync hook by its shape, so a new install repoints it"`

### Task 6: `hub setup`: connect, commands, auto sync, checklist

**Files:**
- Create: `apps/collector/src/setup.ts`, `apps/collector/src/checks.ts`
- Modify: `apps/collector/src/cli.ts` (dispatch, USAGE, `doctorCase` uses `checks.ts`), `apps/collector/src/bin.ts` (`onInterrupt`)
- Test: `apps/collector/test/setup.test.ts`

**Interfaces:**
- Consumes: `HUB_VERSION` (Task 1); `connectWithCode`, `Config.label` and `Config.setup_version` (Task 4); `getStatus(...).label` (Tasks 2 and 4); `autoOn`, `repointHook` and `autoStatus` (Task 5); `friendlyMessage`, `UnreachableError` and `HttpStatusError` (Task 3).
- Produces, in `checks.ts`:
  - `export type Mark = '✓' | '!' | '✗' | '–'`
  - `export type Row = [Mark, string]`
  - `export function printRows(io: Io, rows: Row[]): void`, which prints each row as `${mark} ${text}`
  - `export function summariesRow(io: Io, cfg: Config, hubWritesSummaries: boolean): Row`, which takes doctor's summaries logic, and `runClaudeCommand` with it if it lives in cli.ts

  `doctorCase` keeps its own label column and calls `summariesRow`, so its output does not change.
- Produces: `export async function setupCase(io: Io, args: string[], sync: () => Promise<number>): Promise<number>`, with flags `--url` (required), `--code`, and `--note`/`--warn` (repeatable: rows the installer passes in to print).
- Produces: `Io.onInterrupt?: (handler: () => void) => () => void`. `bin.ts` implements it with `process.once('SIGINT', …)`: it calls the handler, then `process.exit(130)`. It returns the remover.

- [ ] **Step 1: Write the failing tests** with the cli.test fakes: `fetchImpl` answering `/api/devices` and `/api/status`, and `runClaude`. Checklist rows:
  - `a first install connects, installs commands, turns auto sync on and prints the checklist`. In order:
    - `✓ hub dev installed in <dir of bundlePath>`
    - each `--note` as `✓ <note>`
    - `✓ Slash commands installed (6)`
    - `✓ Connected to https://hub.test as "my-mac"`
    - `✓ Auto sync on (runs when a Claude Code session ends)`
    - the summaries row

    Then `config.setup_version === 'dev'`, and the exchange body's `name` is `io.hostname()`.
  - `a re-run keeps the name, leaves auto sync off when it was off, and says already current`. Use `setup_version: 'dev'` and `label: 'MRC'`, with auto off. Expect the rows `✓ hub dev already current`, `– Auto sync off (turn on with: hub auto on)`, and a request body `name` of `'MRC'`.
  - `an update says from and to`: `setup_version: '2026.10.01-aaaaaaa'` gives `✓ hub dev, updated from 2026.10.01-aaaaaaa`. Every version row starts `✓ hub <version>`.
  - `a re-run repoints an old hook even when it says nothing else about auto`.
  - `without a code and already connected it checks the token and keeps it`: `✓ Connected to https://hub.test as "MRC"`, with no `/api/devices` request.
  - `without a code and not connected it says how to connect and returns 0`: `! Not connected yet. Paste the line from Sign-ins → Add a computer, or run: hub login`. The slash commands are still installed. This is the documented two-step path (`curl … | sh`, then `hub login`), so it is not a failure. ✗ and exit 1 are kept for a failed connection: a bad code, an unreachable hub, or a revoked token.
  - `a revoked token without a code says the computer was disconnected` (Review Focus 2): status answers 401, and the row is `✗ This computer was disconnected from the hub. Get a new line from Sign-ins → Add a computer and paste it.`
  - `a new hub with a code says which hub it was connected to`: `✓ Connected to https://new.test as "my-mac" (was https://old.test)`.
  - `no Claude Code skips auto sync and says why`: `– Auto sync skipped: Claude Code isn't installed`.
  - `a broken settings.json warns on the auto row and setup still succeeds` (Review Focus 3): `! Auto sync not changed: ~/.claude/settings.json is not valid JSON …`, and the return value is 0.
  - `--warn rows print with !`.
- [ ] **Step 2: Run them and confirm they fail.** Run `pnpm vitest run apps/collector/test/setup.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement `setupCase`.**
  - Print the version row first. The previous version is the config's `setup_version`; a missing config file means a first install.
  - Then the notes, then the commands, then connect.
  - When the computer is connected: run `repointHook` every time. Turn auto on only on a first install, and only when `runClaude(['auth','status','--json']).found`. Then the summaries row.
  - Save `setup_version = HUB_VERSION`. Print the warn rows, and return 1 if any row is ✗.
  - Add `setup` to dispatch as `setupCase(io, rest, () => dispatch(['sync'], io))`, and add one USAGE line: `setup --url URL [--code CODE]  set up this computer (run by the installer)`.
- [ ] **Step 4: Run them and confirm they pass,** along with the whole collector suite. The doctor tests must not change.
- [ ] **Step 5: Commit.** `git commit -m "Add hub setup: connect, install commands, turn on auto sync and print a checklist"`

### Task 7: `hub setup`: pick projects, then run the first sync in the foreground

**Files:**
- Modify: `apps/collector/src/setup.ts`
- Test: `apps/collector/test/setup.test.ts`

**Interfaces:**
- Consumes: `newProjects`, `listProjects`, `Io.onInterrupt`, and the `sync` callback from Task 6.
- Produces: `export function parsePicks(answer: string, count: number): number[] | 'all' | null`. It takes 1-based numbers separated by spaces or commas, `all`, or `''` for none (an empty array). It returns `null` for anything it can't read.

- [ ] **Step 1: Write the failing tests.**
  - `parsePicks`: `'1 3'` → `[1, 3]`; `'1,3'` → `[1, 3]`; `'all'` → `'all'`; `''` → `[]`; `'7'` with count 6 → `null`; `'x'` → `null`.
  - `lists undecided projects newest first and tracks the picks, declining the rest`. Output contains `Found 3 projects on this computer:` and a numbered row per project with `<n> sessions` and the date. The prompt is `Which should go to the hub? Numbers (e.g. 1 3), "all", or Enter for none: `. After answering `1`, project 1 is in `tracked`, the others are in `declined`, and `sync` was called once.
  - `an unreadable answer asks once more, then picks nothing`: with answers `x` and `x`, the prompt is asked twice, nothing is decided, and sync is not called.
  - `Enter decides nothing and runs no sync`: `tracked` and `declined` are unchanged.
  - `without a terminal it picks nothing and says how to choose later` (Review Focus 5): with `io.interactive = false`, nothing is asked and the output ends `Run hub sync in a terminal to choose which projects to upload.` The return value is 0.
  - `the first sync's last line`: after sync returns 0, `Done. This computer syncs when a Claude Code session ends; run hub sync any time.`
  - `Ctrl+C during the first sync prints how the rest uploads`: a fake `onInterrupt` captures the handler, which the test calls during `sync`. The output contains `Stopped. The rest uploads on the next sync, or run hub sync.`, and the remover is called after sync.
  - `already-decided projects are not offered again on a re-run`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement it.** The pick step runs only when the computer is connected. Reuse the row data `offerNewProjects` uses: `mainSessions` and `shortName`/`displayName`, moved to a module both can import if needed.
- [ ] **Step 4: Run them and confirm they pass,** along with the whole collector suite.
- [ ] **Step 5: Commit.** `git commit -m "Let hub setup pick projects and run the first sync in the foreground"`

### Task 8: The sh installer hands over to `hub setup`

**Files:**
- Modify: `apps/server/src/client-dist.ts` (`installScript`)
- Test: `apps/server/test/client-dist.test.ts`

**Interfaces:**
- Consumes: `hub setup --url --code --note --warn` (Task 6).
- Produces: `installScript(publicUrl: string): string`, the same signature.

Behaviour to pin, in order:
1. **Parse `--code`** from `"$@"`.
2. **Check Node.** If it is missing or older than 22, print:
   ```
   context-hub needs Node 22 or newer (found: <v|none>).
   Install it with: <brew install node | the nodejs.org link>
   then open a new terminal and paste the same line again. If more than 10 minutes have passed, get a new line from Sign-ins → Add a computer.
   ```
   `brew install node` is offered only on macOS when `brew` is on PATH. Then exit 1, having changed nothing.
3. **Download the bundle.** On failure: `Couldn't download hub from <HUB>/hub.mjs. Nothing was changed. Paste the line again.` and exit 1.
4. **Write the launcher** (unchanged).
5. **Fix PATH.** Find the `hub` that the user's PATH would run, before any change.
   - If `~/.local/bin` is not on PATH, or another `hub` wins, append `export PATH="$HOME/.local/bin:$PATH" # added by context-hub` to the login shell's profile (`~/.zshrc` for zsh, `~/.bashrc` for bash, otherwise `~/.profile`). Only once: grep for the marker first.
   - Note: `Added ~/.local/bin to the front of PATH in <profile> (open a new terminal to use hub by name)`.
   - If the profile can't be written: `--warn "Couldn't update <profile>. Run hub by its full path: $BIN/hub"`. Setup still runs.
6. **Take over old launchers.** Every other `hub` on PATH whose text matches `context-hub|collector/dist/bin\.js|hub\.mjs` is moved to `<path>.old`, with the note `Renamed the old hub at <path> to <path>.old`. A non-context-hub `hub` that wins gets `--warn "Another hub at <path> comes first on PATH; this one is at $BIN/hub"`.
7. **Run setup.** `"$BIN/hub" setup --url <HUB> ${code:+--code "$code"} [--note …] [--warn …]`, reading from `/dev/tty` when `(exec </dev/tty) 2>/dev/null` succeeds, and with no redirect otherwise. Exit with setup's exit code and no extra output.

- [ ] **Step 1: Write the failing tests.** Update the existing `installs, updates in place and leaves ~/.context-hub alone` test: `ran.log` now holds `setup --url https://hub.test` twice, plus a note line the first time. Add (all `skipIf(win32)`, using the same fake-curl and stub-bundle approach):
  - `passes the code to setup`: running with `-s -- --code ABCD-EFGH` gives `setup --url https://hub.test --code ABCD-EFGH`.
  - `stops before changing anything when Node is too old`: a fake `node` prints `20.11.0`; the output contains `found: 20.11.0`, and neither the bundle nor the launcher exists.
  - `adds the PATH line to the profile once`: with `SHELL=/bin/zsh`, run twice; `.zshrc` has exactly one line containing `# added by context-hub`.
  - `renames an old context-hub launcher that comes first on PATH`: a `hub` in a dir ahead on PATH holding `exec node /src/context-hub/apps/collector/dist/bin.js "$@"` becomes `hub.old`, and its note reaches setup.
  - `leaves a hub that isn't ours and warns`.
  - `runs setup without /dev/tty when there is none` (Review Focus 5): run with `setsid`, or with no controlling terminal as the test runner already has; setup still runs.
  - `a failed download changes nothing`: the fake curl exits 22, the old bundle is unchanged, and the output names `hub.mjs`.
- [ ] **Step 2: Run them and confirm they fail.** Run `pnpm vitest run apps/server/test/client-dist.test.ts`. They run in the Docker build and on the Mac, and are skipped on Windows.
- [ ] **Step 3: Implement the changes in `installScript`.**
- [ ] **Step 4: Run them and confirm they pass,** on the Mac or in WSL. On this PC also run `wsl sh -n` on the generated script, if available, as a syntax check.
- [ ] **Step 5: Commit.** `git commit -m "Install with one line on macOS and Linux: code, PATH and setup in one go"`

### Task 9: The PowerShell installer at `/install.ps1`

**Files:**
- Modify: `apps/server/src/client-dist.ts` (new `installScriptPs1`), `apps/server/src/http.ts` (the route next to `/install`)
- Test: `apps/server/test/client-dist.test.ts`

**Interfaces:**
- Produces: `installScriptPs1(publicUrl: string): string`, served at `GET|HEAD /install.ps1` as `text/plain; charset=utf-8`, with the same headers and the same 404 without a public URL.

Behaviour to pin (the whole script inside `& { … }`, using `return` and never `exit`):
1. **Read the code.** `$code = $env:HUB_CODE`, then `Remove-Item Env:HUB_CODE -ErrorAction SilentlyContinue`.
2. **Check Node** (≥ 22). If it is missing or too old, give the same message as sh, with `Install it with: winget install OpenJS.NodeJS.LTS`, then `return`.
3. **Download.** `Invoke-WebRequest -UseBasicParsing <HUB>/hub.mjs -OutFile <tmp>`, then move it to `%LOCALAPPDATA%\context-hub\hub.mjs`. On failure, give the same message as sh, then `return`.
4. **Write the launcher.** `%LOCALAPPDATA%\context-hub\bin\hub.cmd` is `@echo off`, then `node "<full path to hub.mjs>" %*`, with CRLF line endings.
5. **Fix PATH.** In the user PATH (`[Environment]::GetEnvironmentVariable('Path','User')`), remove any existing copies of the bin folder and put it first. Set `$env:Path` the same way for this session. Note: `Added <bin> to the front of your PATH (user)`, only when it changed. If the user PATH can't be written, warn `Couldn't update your PATH. Run hub by its full path: <bin>\hub.cmd` and carry on.
6. **Take over old launchers.** For every `hub`, `hub.cmd` and `hub.ps1` from `Get-Command hub -All` outside the bin folder whose text matches `context-hub|collector\\dist\\bin\.js|hub\.mjs`: rename it to `<name>.old`, replacing an older `.old`, and note it. Warn as in sh about a non-context-hub `hub` that still wins.
7. **Run setup.** `& node "<hub.mjs>" setup --url <HUB> @codeArgs @noteArgs`.

- [ ] **Step 1: Write the failing tests.**
  - `serves /install.ps1 with the address filled in`: status, headers, and a body containing `& {`, `'https://hub.test/hub.mjs'` and `Remove-Item Env:HUB_CODE`.
  - `the script never calls exit and uses no PowerShell 7 syntax`: the body does not match `/\bexit\b/`, `/&&|\|\||\?\?/`, or `/\?\s*[^:]+\s*:/`.
  - `quotes an address that holds a quote`: a single quote becomes `''` inside PowerShell single quotes.
  - `quotes a LOCALAPPDATA with spaces in hub.cmd` (Review Focus 4): the line that writes `hub.cmd` puts the bundle path in double quotes (`node "<path>" %*`), and every path the script builds comes from `Join-Path` on `$env:LOCALAPPDATA` and is used quoted.
  - `puts the bin folder first in the user PATH only once`: the PATH step filters out existing copies of the bin folder before prepending it (a text assertion on that expression).

  The script is not run automatically, because running it would write the real user PATH. It carries no test-only switches. Its real run is Task 11 step 5.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement `installScriptPs1` and the route.**
- [ ] **Step 4: Run them and confirm they pass** on this Windows PC (`pnpm vitest run apps/server/test/client-dist.test.ts`).
- [ ] **Step 5: Commit.** `git commit -m "Add the Windows installer at /install.ps1"`

### Task 10: The Add a computer page shows the two lines

**Files:**
- Modify: `apps/server/src/client-dist.ts` (`installLines`), `apps/server/src/web/pages.ts` (`codePage`), `apps/server/src/web/routes.ts` (`issueCode` passes the OS), and the dashboard's existing script asset (`apps/server/src/web/assets.ts`) for copy buttons
- Test: `apps/server/test/web-pages.test.ts`

**Interfaces:**
- Produces: `installLines(hubUrl: string, code: string): { unix: string; windows: string }`, giving exactly the two lines in Global Constraints.
- Produces: `codePage(purpose, code, hubUrl, csrf, os: 'windows' | 'unix')`. `issueCode` passes `'windows'` when the request's User-Agent matches `/Windows/i`.

- [ ] **Step 1: Write the failing tests.**
  - `installLines` gives exactly `curl -fsSL https://hub.test/install | sh -s -- --code ABCD-EFGH` and `$env:HUB_CODE='ABCD-EFGH'; irm https://hub.test/install.ps1 | iex`.
  - `a device code page shows both lines with the code, the reported OS first`: for `os: 'windows'`, the escaped Windows line comes before the macOS/Linux line, with the headings `Windows (PowerShell)` and `macOS / Linux`. The code still appears on its own, with `Or run hub login and enter this code.`
  - `each line has a copy button`: `data-copy` attributes match the lines.
  - `without a public URL the page shows only the code and hub login`, as today.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement it.** The copy handler goes in the existing dashboard script asset, so the page's CSP needs no change.
- [ ] **Step 4: Run them and confirm they pass,** along with `pnpm vitest run apps/server/test`.
- [ ] **Step 5: Commit.** `git commit -m "Show a one-line install with the code inside on Add a computer"`

### Task 11: README, and a real run on both computers

**Files:**
- Modify: `README.md` (sections "Install and log in", "Sync automatically", "Status" table)

- [ ] **Step 1: Rewrite "Install and log in"** as one path per OS: open Add a computer, paste the line. Keep `hub login` as the manual fallback. Remove the clone-and-`hub.cmd` Windows steps. In "Sync automatically", say auto sync is on after a first install. In Status, move "Windows installer" to Built.
- [ ] **Step 2: Run the full gates.** `pnpm typecheck && pnpm test`. Expected: clean, with no tests deleted or skipped that were running before.
- [ ] **Step 3: Commit.** `git commit -m "README: one line per OS to set up a computer"`
- [ ] **Step 4: Open the PR, and stop until it is merged and deployed.** Deploys run only from `main`, and the installers are served by the deployed hub, so steps 5 to 7 can't happen on the branch. Don't fake them with a local server. Wait for the owner to merge and for the deploy to finish.
- [ ] **Step 5: Real run on this Windows PC,** against the live hub. Get a code from Add a computer, paste the Windows line in a new PowerShell window, and check:
  - the checklist
  - `%APPDATA%\npm\hub.cmd` became `hub.cmd.old`
  - `Get-Command hub` points at `%LOCALAPPDATA%\context-hub\bin\hub.cmd` in a **new** window
  - the auto-sync hook in `~/.claude/settings.json` points at the new bundle, and there is only one
  - Sign-ins shows one live token for this computer

  Paste a second line to check that re-pasting retires the old token.
- [ ] **Step 6: Real run on the Mac.** Repeat with the macOS line, and check the `.zshrc` line and the checklist.
- [ ] **Step 7:** Note any deviations in `docs/superpowers/plans/fresh-install-deviations.md` in a follow-up commit to `main` through a small PR. Close issue #6 once both real runs pass.
