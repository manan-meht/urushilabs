import { defineConfig } from 'vitest/config'
import path from 'path'
import { fileURLToPath } from 'url'

// .mts, not .ts: vite 7 is ESM-only, so vitest must load this config as ESM.
// As a .ts file with no "type": "module" in package.json it was loaded through
// the CommonJS path, where `vitest/config` does require('vite') and dies with
// ERR_REQUIRE_ESM before a single test runs.
const dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
  resolve: {
    alias: {
      '@': path.resolve(dirname, './src'),
    },
  },
})
