# Code-scanning alerts 2, 4, 5, 7

Goal: close the four open code-scanning alerts by fixing their causes, not by dismissing them.

## Task 1: alert 2, polynomial ReDoS in `normalizeRemote` (`packages/core/src/remote.ts:32`)

`path.replace(/\/+$/, '')` is quadratic on long runs of slashes that don't end the string (40k slashes took 554 ms).

- **Test first** (`packages/core/test/remote.test.ts`): `normalizeRemote('https://github.com/a' + '/'.repeat(100_000) + 'x')` returns within 50 ms. It must fail before the fix.
- **Test:** existing cases still pass, and `https://github.com/me/app///` still normalizes to `github.com/me/app`.
- **Fix:** strip trailing slashes with a `while (path.endsWith('/'))` loop.

## Task 2: alert 5, incomplete escaping in `canonicalKey` (`packages/core/src/remote.ts:10`)

`host.replace(/\./g, '\\.')` escapes only dots.

- **Fix:** escape every regex metacharacter: `host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')`.
- **Test:** the existing `canonicalKey` tests pass unchanged. The hosts are constants, so there is no behaviour change to test.

## Task 3: alert 4, bad HTML-filter regex (`apps/server/test/web-shell.test.ts:49`)

`/<script[^>]*>[^<]+<\/script>/` misses `</script >` and other forms.

- **Fix:** replace the two negative `<script` regexes with:
  - exactly one `<script` in the page (case-insensitive count);
  - the existing positive match for that exact tag, `<script src="/assets/app.js?v=…"></script>`.
- **Check:** the test still passes, and it fails if an inline `<script>x</script>` is added to the shell (checked by hand once, then reverted).

## Task 4: alert 7, missing workflow permissions (`.github/workflows/deploy.yml:65`)

- **Fix:** add `permissions: {}` to the `deploy` job. It uses only `secrets.*` over SSH, never `GITHUB_TOKEN`.
- **Check:** the YAML parses. The real proof is the first deploy after merge.

## Done when

- `pnpm test`, `pnpm typecheck` and `pnpm lint` are green, with lint no worse than `main` (5 warnings, 2 infos).
- The PR's CodeQL run shows alerts 2, 4, 5 and 7 fixed.
- The deploy after merge goes green. Not verifiable before merge.
