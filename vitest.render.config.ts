import { getViteConfig } from 'astro/config';
import type { Plugin, PluginOption, UserConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// The `render` project (Admin v2 F6): specs under tests/render render .astro components
// with Astro's container API, so a refactor of a public component can be held to its
// served bytes (tests/render/sections.spec.ts). The unit project (vitest.config.ts) has
// no Astro compiler; this one is Astro's own Vite config (getViteConfig reads
// astro.config.mjs), with two changes:
//
//   * the Cloudflare adapter's Vite plugins are dropped: they run the Worker environments
//     in workerd and refuse a config that externalises Node built-ins, as Vitest's does.
//     Nothing a component renders depends on them; the bindings a page reads arrive
//     through `cloudflare:workers`, stubbed below as in the unit project;
//   * `astro:env/*` are the unit project's stubs (the dummy Supabase values keep every
//     loader on its "not configured" path, so no spec reaches a network).
const stub = (name: string) => fileURLToPath(new URL(`./tests/stubs/${name}`, import.meta.url));

const astroVite = getViteConfig(
  {
    resolve: {
      alias: {
        'astro:env/client': stub('astro-env-client.ts'),
        'astro:env/server': stub('astro-env-server.ts'),
        'cloudflare:workers': stub('cloudflare-workers.ts'),
      },
    },
    test: {
      name: 'render',
      environment: 'node',
      include: ['tests/render/**/*.spec.ts'],
    },
  } as UserConfig,
  { logLevel: 'error' },
);

const flatten = (options: PluginOption[]): Plugin[] =>
  options.flatMap((o) => (Array.isArray(o) ? flatten(o) : o && 'name' in o ? [o] : []));

const isCloudflare = (p: Plugin) => /cloudflare/i.test(p.name);

export default async (env: { command: 'build' | 'serve'; mode: string }) => {
  const config = await astroVite(env);
  return { ...config, plugins: flatten(config.plugins ?? []).filter((p) => !isCloudflare(p)) };
};
