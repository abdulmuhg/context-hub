import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/bin.ts'],
  format: ['esm'],
  target: 'node22',
  clean: true,
  noExternal: ['@context-hub/core'],
  banner: { js: '#!/usr/bin/env node' },
});
