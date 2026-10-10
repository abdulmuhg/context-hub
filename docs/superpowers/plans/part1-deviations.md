# Part 1 deviations

## Task 1

- `pnpm-workspace.yaml`: added `allowBuilds: { esbuild: true }`. pnpm 11 blocked esbuild's postinstall script (ERR_PNPM_IGNORED_BUILDS) after `pnpm add -D -w typescript vitest tsx @types/node`; vitest and tsx depend on esbuild. This is the minimal approval.
- Resolved versions are newer than the plan assumed (typescript 7.x, vitest 5.x, @types/node 26.x); no code change was needed, typecheck and tests pass as written.
