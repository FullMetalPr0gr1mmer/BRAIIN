// @ts-check
import { defineConfig, envField } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
// NOTE: @astrojs/react is a dependency but the integration is intentionally NOT
// registered in Phase 0 — public pages ship ZERO client JS (Performance pillar).
// Re-enable `react()` in Phase 3 when the admin islands are built.

/**
 * Braiin Station — render model (see CLAUDE.md §2 "Render tiers"):
 *   Tier A  Static, indexable shell  → SSR + long `s-maxage`, purge-by-tag on publish
 *   Tier B  Server Islands (server:defer) → non-indexable dynamic holes only
 *   Tier C  SSR Worker (/admin/**, Style-Finder API) → private, no-store
 *
 * `output: 'server'` makes routes on-demand by default; indexable routes are
 * edge-cached via Cache-Control headers (publish = cache event, NOT a rebuild),
 * so a CMS edit never triggers a full SSG rebuild.
 */
export default defineConfig({
  // TODO(phase-0): replace with the real production origin before launch.
  site: 'https://www.braiinstation.com',
  output: 'server',
  // 'ignore': both `/x` and `/x/` resolve (no 404s); the per-page self-referential
  // canonical in <SeoHead> consolidates to the non-trailing URL for SEO.
  trailingSlash: 'ignore',

  adapter: cloudflare({
    // Adapter locks (CLAUDE.md §2): Cloudflare-native image transforms + Workers bindings.
    imageService: 'cloudflare-binding',
    imagesBindingName: 'IMAGES',
    sessionKVBindingName: 'SESSION',
    platformProxy: { enabled: true },
  }),

  integrations: [],

  // Path-based i18n: `/` (EN) + `/ar/` (AR). hreflang + x-default handled in <SeoHead>.
  i18n: {
    locales: ['en', 'ar'],
    defaultLocale: 'en',
    routing: {
      prefixDefaultLocale: false,
      redirectToDefaultLocale: false,
    },
  },

  image: {
    // Cloudflare image transforms via the IMAGES binding; <Picture> enforces width/height.
    domains: [],
  },

  // Astro's built-in CSRF/origin check on state-changing requests (defense-in-depth
  // alongside the explicit __Host-csrf double-submit in src/middleware.ts).
  security: { checkOrigin: true },

  /**
   * Type-safe env via astro:env. SECRETS (access:'secret') are server-only and
   * NEVER reach the client bundle. PUBLIC_* are client-safe and non-sensitive.
   * CLAUDE.md Pillar 1: service-role key, Anthropic key, signing keys never PUBLIC.
   */
  env: {
    schema: {
      // ---- Client-safe (public) ----
      PUBLIC_SITE_URL: envField.string({ context: 'client', access: 'public' }),
      PUBLIC_SUPABASE_URL: envField.string({ context: 'client', access: 'public' }),
      PUBLIC_SUPABASE_ANON_KEY: envField.string({ context: 'client', access: 'public' }),

      // ---- Server, non-secret config ----
      AI_DAILY_USD_CAP: envField.number({ context: 'server', access: 'public', default: 5 }),

      // ---- Server SECRETS (never client-bundled) ----
      SUPABASE_DB_POOL_URL: envField.string({ context: 'server', access: 'secret' }), // Supavisor :6543, pgbouncer=true
      SUPABASE_SERVICE_ROLE_KEY: envField.string({ context: 'server', access: 'secret' }),
      LEAD_PII_ENC_KEY: envField.string({ context: 'server', access: 'secret' }),
      AUDIT_HMAC_KEY: envField.string({ context: 'server', access: 'secret' }),
      NOTIFY_LEAD_SECRET: envField.string({ context: 'server', access: 'secret' }),
      ANTHROPIC_API_KEY: envField.string({ context: 'server', access: 'secret', optional: true }),
    },
  },
});
