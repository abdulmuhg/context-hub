# Part 1 deviations

## Task 1

- `pnpm-workspace.yaml`: added `allowBuilds: { esbuild: true }`. pnpm 11 blocked esbuild's postinstall script (ERR_PNPM_IGNORED_BUILDS) after `pnpm add -D -w typescript vitest tsx @types/node`; vitest and tsx depend on esbuild. This is the minimal approval.
- Resolved versions are newer than the plan assumed (typescript 7.x, vitest 5.x, @types/node 26.x); no code change was needed, typecheck and tests pass as written.

## Task 3: personal data filter

Rewrote `filterPersonal` in `packages/core/src/personal.ts` after review (plan tests unchanged, new tests added):
- Card detection: the plan's single greedy regex per run let a trailing or leading short group (CVV, expiry, order number) turn the whole run into one non-Luhn candidate, so the real card leaked. Now each separator-joined digit run is split into groups and contiguous windows of 13-19 digits aligned to group boundaries are tried, longest and leftmost first, with a Luhn check.
- Values starting with `+`: the plan's `(?<![\d+])` lookbehind made them unmatchable. The regex now includes a literal `\+` for such values, and still requires no digit or `+` before it.
- Overlaps: the plan applied entries sequentially to already-rewritten text, so short entries matched inside markers and results depended on entry order. Matches for all entries and cards are now collected on the original text, overlaps resolved (longest wins, then stronger level full > partial > warn, then leftmost), and the text spliced once. Findings stay per label / `card`.
