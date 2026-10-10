# Part 1 deviations

## Task 1

- `pnpm-workspace.yaml`: added `allowBuilds: { esbuild: true }`. pnpm 11 blocked esbuild's postinstall script (ERR_PNPM_IGNORED_BUILDS) after `pnpm add -D -w typescript vitest tsx @types/node`; vitest and tsx depend on esbuild. This is the minimal approval.
- Resolved versions are newer than the plan assumed (typescript 7.x, vitest 5.x, @types/node 26.x); no code change was needed, typecheck and tests pass as written.

## Task 3: personal data filter

Rewrote `filterPersonal` in `packages/core/src/personal.ts` after review (plan tests unchanged, new tests added):
- Card detection: the plan's single greedy regex per run let a trailing or leading short group (CVV, expiry, order number) turn the whole run into one non-Luhn candidate, so the real card leaked. Now each separator-joined digit run is split into groups and contiguous windows of 13-19 digits aligned to group boundaries are tried, longest and leftmost first, with a Luhn check.
- Values starting with `+`: the plan's `(?<![\d+])` lookbehind made them unmatchable. The regex now includes a literal `\+` for such values, and still requires no digit or `+` before it.
- Overlaps: the plan applied entries sequentially to already-rewritten text, so short entries matched inside markers and results depended on entry order. Matches for all entries and cards are now collected on the original text, overlaps resolved (longest wins, then stronger level full > partial > warn, then leftmost), and the text spliced once. Findings stay per label / `card`.

## Task 3 (fix round 2): card window search and warn precedence

- `cardWindows` tried every window length over the whole run (and recursed on remainders), which was super-polynomial on long space-separated digit lists (800 single digits took 14.7s). It now enumerates only windows of 13-19 digits (at most 19 groups per start), sorts them by group count then position and takes non-overlapping ones greedily. Same results as before: longest first, leftmost, group-aligned, Luhn-checked.
- A warn hit (no replacement) now loses to any partial/full hit it overlaps, so a stronger nested entry is no longer swallowed by a longer warn-level card hit. A displaced warn hit is not reported.

## Task 4: session sanitising

- `packages/core/src/secrets.ts`: removed the leading `\b` from the github, anthropic, google, slack, stripe and jwt rules (distinctive prefixes only; openai, aws and npm keep `\b` because `sk-`, `AKIA` and `npm_` can appear inside ordinary words such as `disk-` or `pnpm_`). The plan test "strips a secret before capping, so one that straddles the cap is still caught" glues a `ghp_` token directly onto 1,990 `x` characters, so `\b` never matched and the token survived. Stripping the prefix boundary is the minimal change that lets the plan test pass unchanged.
- `sanitize.ts` and `remote.ts` are exactly as in the plan.
- Fix round: restored the doubled backslashes in the Windows-path literals of `remote.test.ts` and `sanitize.test.ts` (lost when the tests were written), and added glued-prefix and negative-guard tests for the unanchored secret rules in `secrets.test.ts`.
