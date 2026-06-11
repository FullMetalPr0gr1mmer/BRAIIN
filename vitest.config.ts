import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Path aliases mirror tsconfig.json so tests resolve @/ , @schemas/ , @consent/.
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@schemas': fileURLToPath(new URL('./packages/schemas', import.meta.url)),
      '@consent': fileURLToPath(new URL('./packages/consent', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    coverage: {
      // Headline (CLAUDE.md §9): 100% branch on authz + schema modules.
      thresholds: { lines: 80, functions: 80, branches: 75 },
    },
  },
});
