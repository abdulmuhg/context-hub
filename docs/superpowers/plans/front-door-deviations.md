# Front door: where the build differs from the plan

## Task 1
- Docker was available: `docker compose config` with no `.env` fails with the `HUB_DOMAIN` message; with `HUB_DOMAIN=hub.test` it prints `PUBLIC_URL: https://hub.test` and `ghcr.io/abdulmuhg/context-hub:latest`. The Dockerfile change and the CI tags were not built or run (the image build and the workflow need CI).
- The `hub-admin` shim is written with `printf` in a `RUN`, since the plan gives only its content, not how to create it.

## Task 3
- `db.test.ts` (and `digest-store.test.ts`) rewind to older schema versions by dropping later migrations' objects by hand. They now also drop the `waitlist` table (`unmigrate14`, called from `unmigrate13`), and `db.test.ts` has a small test for migration 14. The plan only mentioned a schema-version assertion, which uses `SCHEMA_VERSION` and needed no change.

## Task 4
- `WebConfig.landing` is a required field, so every test that builds a `WebConfig` literal (nine files) gained `landing: false`.
- `web-session.test.ts` asserted the old sign-in hint ("Run hub connect on your PC to get one."); it now asserts the reworded hint (`<code>hub connect</code>`), as the plan's reworded hint requires.
- `head` is exported from `html.ts`, and the theme button markup is now an exported `THEME_BUTTON` constant that `pageShell` reuses (output unchanged), so the landing page draws the same button.
- The landing check in `handleWeb` sits just after the session lookup instead of before it; the behaviour is the same (signed-in `/` is still the Overview).
- Step 8 (look at it): done in the in-app browser against a built server with `LANDING=on`, at desktop-pane width and 375px, in both colour schemes: no horizontal page overflow at 375px; code rows scroll inside themselves. Screenshots were taken at reduced scale and the pane showed some rendering artefacts in one capture, so this is a visual sanity check, not a pixel review.

## Task 5
- The waitlist limiter is built inside `createHandler` in `http.ts` next to the sign-in limiter and is not an `AppDeps` option (tests use the real default, which is enough for the eleventh-post test).
- Added one test the plan did not list: a full waitlist answers 503 with the "full" note and stores nothing more.
- Step 6 was done by hand against a built server on a scratch database: good address stored lowercased, bad one 400, repeat gives the same thank-you page, and `admin-bin.js waitlist` listed one entry.

## Task 6
- The only link into the old README found by the search was the text in `apps/collector/src/cli.ts` (`README: "Read from the hub in the Claude apps"`), now pointing at `docs/using.md`; no test asserted it. No README anchors (`#which-path`, `#sign-in-codes`, `#settings`, `#backups`) were linked from code, installers, `deploy/`, `CONTRIBUTING.md` or `SECURITY.md`. Anchors inside the moved text were kept valid by checking each heading's slug after the heading levels shifted.
- `docs/using.md` keeps the old "hosting, first computer ever" row verbatim (`docker exec … node /app/dist/admin-bin.js device-code`). That spelling still works in every image; `docs/self-hosting.md` and `deploy/README.md` use `hub-admin`.
- The README is 80 lines. Its quick-start block is Task 1's block verbatim.

## Review
- The `hub-admin` shim in the `Dockerfile` was written with real line breaks inside the `RUN` and a literal `\n` before `&&`, which Docker cannot parse; the image build would have failed. Rewritten as one `printf` with `\n` escapes and a proper line continuation. Not built locally (no Docker daemon running); the first CI build is the check.

## Follow-up

### Task 1
- The plan said the oversize-body test would fail before the change. It does not: a 10,000-byte email is already refused by `normalizeEmail` (254-character limit) with the same 400 page, so the response is identical with and without the 4 KB limit. The test is kept as the plan gave it (it still guards that the server keeps answering). The gzip test is the one that goes red without the change; I added an assertion on the form's "does not look like an email" text, since before the change the answer was a JSON 400.
- The plan's tests use `url`/`db`; the waitlist tests live in the `the waitlist form` block, so they use `wUrl`/`wDb`.
