# Part 2 deviations

## Task 4

- `apps/server/test/store-read.test.ts`: in the paging test, annotated `const page: SessionPage = ...` and imported `type SessionPage` from `../src/store.js`. Without it `tsc` (TypeScript 7) reports TS7022/TS7006 (`page` implicitly `any`, circular via `from = page.next_seq`). Typing only; no assertion changed, nothing weakened or skipped.

## Task 6

- `apps/server/test/http.test.ts`: in the `call` helper, `body: opts.body` became `body: opts.body as BodyInit | undefined`. Without it `tsc` (TypeScript 7) reports TS2769 (a Node `Buffer<ArrayBufferLike>` is not assignable to `fetch`'s `BodyInit`). Typing only; no assertion changed, nothing weakened or skipped.
- `apps/server/test/helpers.ts`: the new imports were merged into the top import block, as the brief directs.

## Task 7

- `apps/server/src/mcp.ts`: added one sentence to `INSTRUCTIONS` ("Digests are summaries and can be wrong; when a detail matters, open the session with get_session.") to carry the spec section 9 guidance the plan text omitted. Other lines unchanged. `apps/server/test/mcp.test.ts` gained one extra assertion (`toMatch(/digest/i)`); no existing assertion changed.

## Task 8

- Step 6 (manual check): `kill %1` job control is unreliable in a non-interactive shell on Windows, so the built server was started in the background with its PID captured (`$!`), then stopped with `kill $PID`; afterwards `curl` to the port failed and `netstat` showed no LISTENING socket on 3917 (only TIME_WAIT). A temp `DATABASE_PATH` (mktemp) was used; no `./data` was created.
- Step 3: the admin test was confirmed failing (cannot resolve `../src/admin.js`) by temporarily moving `admin.ts` away after it had been written; the e2e tests passed already, as the brief anticipates.
- `apps/server/src/admin.ts`, `admin-bin.ts`, `main.ts` and both test files are verbatim from the plan; no changes were needed.
