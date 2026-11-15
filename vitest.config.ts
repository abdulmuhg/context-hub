import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Worktrees and scratch dirs hold full copies of the repo; don't run their tests.
    exclude: [...configDefaults.exclude, '.claude/**', '.superpowers/**'],
    // Keeps every test away from the real `claude` on the machine running them.
    setupFiles: ['./apps/collector/test/setup.ts'],
  },
});
