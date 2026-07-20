import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Path aliases mirror tsconfig.json so tests resolve @/ , @schemas/ , @consent/.
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@schemas': fileURLToPath(new URL('./packages/schemas', import.meta.url)),
      '@consent': fileURLToPath(new URL('./packages/consent', import.meta.url)),
      // `astro:env/*` is a virtual module that only exists inside the Astro build, so
      // anything importing config was untestable. Stubbing it lets tests reach the
      // routes and API handlers in src/pages/.
      'astro:env/client': fileURLToPath(
        new URL('./tests/stubs/astro-env-client.ts', import.meta.url),
      ),
      'astro:env/server': fileURLToPath(
        new URL('./tests/stubs/astro-env-server.ts', import.meta.url),
      ),
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
