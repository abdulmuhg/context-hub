import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Keeps every test away from the real `claude` on the machine running them.
    setupFiles: ['./apps/collector/test/setup.ts'],
  },
});
