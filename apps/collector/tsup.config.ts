import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/bin.ts'],
  format: ['esm'],
  target: 'node22',
  clean: true,
  define: { __HUB_VERSION__: JSON.stringify(process.env.HUB_VERSION ?? 'dev') },
  noExternal: ['@context-hub/core'],
  banner: { js: '#!/usr/bin/env node' },
});
