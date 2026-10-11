import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts', 'src/admin-bin.ts'],
  format: ['esm'],
  target: 'node22',
  clean: true,
  noExternal: ['@context-hub/core'],
  external: ['better-sqlite3'],
  banner: { js: '#!/usr/bin/env node' },
});
