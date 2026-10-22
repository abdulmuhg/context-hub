# Fresh install: deviations from the plan

Nothing below was run: the owner chose no per-task test or typecheck. The review session runs `pnpm typecheck` and `pnpm test`.

- **Task 3.** `Fail` is now also thrown for an unreadable `settings.json` (`auto.ts`) and an unreadable `config.json`/`state.json` (`config.ts`), so their existing messages still reach the screen as they are instead of becoming "Something went wrong". `friendlyMessage` also maps a 429 to "Too many wrong codes from this address…".
- **Task 4.** `Config.setup_version` is added here, not in Task 6, because `Config` is edited once.
- **Task 6.** `summariesRow` returns `✗` as doctor does; `hub setup` shows it as `!` (Claude Code missing or signed out is a warning there, never a failure).
- **Task 9.** The old-launcher step walks the directories of the session PATH and looks for `hub`, `hub.cmd` and `hub.ps1` in each, instead of `Get-Command hub -All`, which does not list an extensionless `hub` (npm's sh shim). The "another hub still wins" warning is worked out from the machine PATH followed by the user PATH, the order Windows uses. The PowerShell script is checked only by parsing it with the 5.1 parser (0 errors) and by text assertions; it has not been run.
- **Task 10.** `installLines` did not exist, so it is new in `client-dist.ts`. The page tests are unit tests of `codePage` in `web-pages.test.ts`; the existing `web-signins.test.ts` checks still hold and were left alone. `codePage`'s `os` argument defaults to `'unix'`.
- **Task 8.** The sh installer was run once by hand in a scratch folder under Git Bash (`--code`, PATH line and old-launcher rename all behaved); its vitest cases are skipped on Windows and still need a run on the Mac or in WSL.

## After the whole-branch review

- **Lost escapes.** The build pass dropped backslashes in a few places: `trimUrl` (`\/`), `parsePicks` (`\d`, `\s`) and three test strings. All are fixed; the generated installers were checked line by line and had none.
- **First install** now means "not connected before this run" rather than "no config file". Otherwise a plain `curl … | sh` (no code) used it up and auto sync never came on after `hub login`.
- **sh installer** compares launchers with `-ef`, so a PATH entry with a trailing slash or a symlinked home can no longer make it rename its own new launcher. Its warning about another program called `hub` now says new terminals run ours.
- **hub.cmd** is `node "%~dp0..\hub.mjs" %*`, written as ASCII, so no profile path is embedded and a folder like `José Smith` works (cmd reads batch files in the console code page).
- **User PATH** is read and written through the registry as `REG_EXPAND_SZ`, so `%USERPROFILE%\…` entries stay unexpanded. The change is then broadcast to new windows. The PowerShell script is now plain ASCII, and a Windows-only test parses it with the real 5.1 parser.
- **Claude Code "found"** for `auth status` now means "it ran", so a signed-out Claude Code reads as signed out, not as not installed.
- **Errors**: 5xx says the hub may be restarting; 404 from `/api/status` or `/api/devices` says the address isn't a context-hub; `ETIMEDOUT`, `ENETUNREACH` and similar errors get plain words.
- **isOurHook** also requires the bundle path to end in `hub.mjs` or `bin.js`, so another tool's `"x" "y" sync --auto` hook is never touched.
