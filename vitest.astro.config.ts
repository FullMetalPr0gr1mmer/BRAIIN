/// <reference types="vitest/config" />
import { getViteConfig } from 'astro/config';
import react from '@astrojs/react';

// The `astro` test project (named in vitest.config.ts): specs under tests/astro/ render
// the admin's server primitives (src/components/admin/ui/, Admin v2 F4b) with Astro's
// container API, which compiles .astro files through Astro's own Vite plugins.
//
// `configFile: false` keeps astro.config.mjs out: its Cloudflare adapter and chunk plan
// are build concerns, and the adapter's dev pipeline has no place in a test run. The React
// integration is the one piece a primitive needs (the kit's .tsx pieces render beside
// them in the gallery spec). `@/` resolves through tsconfig.json's paths, as in the build.
export default getViteConfig(
  {
    test: {
      name: 'astro',
      environment: 'node',
      include: ['tests/astro/**/*.spec.ts'],
    },
  },
  { configFile: false, integrations: [react()], logLevel: 'warn' },
);
