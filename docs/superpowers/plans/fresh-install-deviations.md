# Fresh install: deviations from the plan

Nothing below was run: the owner chose no per-task test or typecheck. The review session runs `pnpm typecheck` and `pnpm test`.

- **Task 3.** `Fail` is now also thrown for an unreadable `settings.json` (`auto.ts`) and an unreadable `config.json`/`state.json` (`config.ts`), so their existing messages still reach the screen as they are instead of becoming "Something went wrong". `friendlyMessage` also maps a 429 to "Too many wrong codes from this address…".
- **Task 4.** `Config.setup_version` is added here, not in Task 6, because `Config` is edited once.
- **Task 6.** `summariesRow` returns `✗` as doctor does; `hub setup` shows it as `!` (Claude Code missing or signed out is a warning there, never a failure).
- **Task 9.** The old-launcher step walks the directories of the session PATH and looks for `hub`, `hub.cmd` and `hub.ps1` in each, instead of `Get-Command hub -All`, which does not list an extensionless `hub` (npm's sh shim). The "another hub still wins" warning is worked out from the machine PATH followed by the user PATH, the order Windows uses. The PowerShell script is checked only by parsing it with the 5.1 parser (0 errors) and by text assertions; it has not been run.
- **Task 10.** `installLines` did not exist, so it is new in `client-dist.ts`. The page tests are unit tests of `codePage` in `web-pages.test.ts`; the existing `web-signins.test.ts` checks still hold and were left alone. `codePage`'s `os` argument defaults to `'unix'`.
- **Task 8.** The sh installer was run once by hand in a scratch folder under Git Bash (`--code`, PATH line and old-launcher rename all behaved); its vitest cases are skipped on Windows and still need a run on the Mac or in WSL.
