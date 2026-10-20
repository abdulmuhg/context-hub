# Device setup: deviations and open points

Recorded while implementing Tasks 1 to 6 and Task 7 Step 1. Steps 2 to 4 of Task 7 are the owner's and reviewer's.

## Deviations

- **Task 1.** `db.test.ts` asserted `SCHEMA_VERSION` is exactly 5 in the migration 5 test; it now says at least 5, and a new migration 6 test asserts exactly 6 and the `purpose` column. No test replays migrations in a way that needed other changes.
- **Task 2.** The dashboard's CSP allows no inline styles, so the large code and the copyable lines use CSS classes (`.code-value`, `.copyline`, `.actions`) added to `web/assets.ts`. An unknown `purpose` gets its own small 400 page (`codeRefusedPage`) rather than reusing the Disconnect not-found page. The Inter font is named directly in `.code-value`.
- **Task 3.** `exchangeDeviceCode` runs consume-and-create in one transaction. A body without a string `code` is a 400 and does not count against the limiter; only a wrong, used or expired code does.
- **Task 5.** `Io` gained an optional `hostname` so the default name is testable. A saved config has `server_url: ''` when unset, so the address falls back with `||`, not `??`. The replace-the-hub question is asked right after the address is known, before the name and code prompts. A trailing slash on the address is dropped before saving.
- **Task 6.** `/install` and `/hub.mjs` also answer HEAD. The public URL is read from `oauth.publicUrl`, else `web.publicOrigin` (main.ts sets both). The Windows skip applies to the installer run test as planned.
- **Task 7 Step 1.** The README also covers the Sign-ins buttons in "Sign-in codes", `hub install-commands` in "Slash commands", and the status table's planned item is now "Windows installer".

## Not verified

- The Dockerfile change (building the collector and copying `bin.js` to `/app/client/hub.mjs`) was not built here: no Docker run. I built the collector with tsup and ran the resulting file as `node hub.mjs`.
- The installer test is skipped on Windows (this machine). I ran the same script by hand under Git Bash with a fake `curl` and a temp `HOME`, twice: both exits 0, launcher and bundle present, `install-commands` ran twice, `config.json` byte-identical. The vitest version of that test has never run for real; it should run on the Linux image build.
- `hub login` against a real hub, and the Mac flow (Task 7 Step 3), were not tried.
