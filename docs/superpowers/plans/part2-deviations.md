# Part 2 deviations

## Task 4

- `apps/server/test/store-read.test.ts`: in the paging test, annotated `const page: SessionPage = ...` and imported `type SessionPage` from `../src/store.js`. Without it `tsc` (TypeScript 7) reports TS7022/TS7006 (`page` implicitly `any`, circular via `from = page.next_seq`). Typing only; no assertion changed, nothing weakened or skipped.
