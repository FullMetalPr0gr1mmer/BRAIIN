// @ts-check
import { defineConfig, envField } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
// Phase 3: the React integration is registered for the /admin islands. Public pages
// still ship ZERO React — Astro only emits the runtime for routes that actually
// hydrate an island, and `manualChunks` below quarantines that runtime into
// `admin-vendor-*.js` so the public 100 KB budget keeps measuring only public JS.
import react from '@astrojs/react';

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
  // No `site`: PUBLIC_SITE_URL (astro:env, inlined at build) is the ONE origin — every
  // canonical, hreflang, og:url, sitemap <loc> and feed link reads it. Astro reads `site`
  // for `Astro.site`, prerendering and the `astro:i18n` absolute-URL helpers, none of which
  // this app uses; the value that sat here was a one-i domain the studio never owned
  // (tests/lib/staleDomain.spec.ts).
  output: 'server',
  // 'ignore': both `/x` and `/x/` resolve (no 404s); the per-page self-referential
  // canonical in <SeoHead> consolidates to the non-trailing URL for SEO.
  trailingSlash: 'ignore',

  adapter: cloudflare({
    // Adapter locks (CLAUDE.md §2): Cloudflare-native image transforms + Workers bindings.
    imageService: 'cloudflare-binding',
    imagesBindingName: 'IMAGES',
    sessionKVBindingName: 'SESSION',
    // NOTE: `platformProxy` was REMOVED from the adapter's options in v14 (silently
    // ignored — it is not in `Options`, and astro.config.mjs is unchecked by tsc).
    // Dropped here; CLAUDE.md §2 names it as an adapter lock and needs a reviewed
    // amendment (§11). The other three locks above survive unchanged.
  }),

  // Pillar 1 (CSP): force EVERY component <script> to an external file. Astro's
  // `renderScript` inlines chunks under `assetsInlineLimit` as a bare
  // `<script type="module">` with NO nonce — which our no-'unsafe-inline' CSP blocks,
  // silently killing the consent banner, contact form, search, error reporter and the
  // Stream facade in production (dev serves them external, so it looks fine locally).
  // 0 = never inline. Astro's top-level `build.assetsInlineLimit` does NOT propagate to
  // the Vite client environment — it must be set here.
  //
  // The named chunk groups below keep the two budgets separable. `.size-limit.json`
  // measures a directory glob, not a route graph, so once the admin hydrates React the
  // public "≤100 KB per route" gate would silently start weighing react-dom and Tiptap
  // and fail on JS no public visitor ever downloads. Forcing every admin-only module into
  // a predictably-named `admin-*` chunk lets the public entry exclude it by name and
  // gives /admin its own honest budget instead.
  vite: {
    build: {
      assetsInlineLimit: 0,
      rollupOptions: {
        output: {
          // Named groups, highest priority first (Admin v2 F4). A group captures the
          // modules its `test` matches PLUS their dependencies (Rolldown's default, the
          // behaviour `manualChunks` had), but a module a higher group already claimed
          // stays there. So the order is the design: React first, then the admin's small
          // shared helpers, then the rich-text editor, then everything else admin.
          //
          // Why named at all: `.size-limit.json` splits public from admin by FILE NAME,
          // so an admin module in an anonymous chunk would be weighed against the public
          // 100 KB budget. Every admin chunk is `admin-*` (src/pages entries are `Admin*`
          // or listed). tests/lib/adminChunks.spec.ts checks a real build: what each
          // chunk holds, that the editor is lazy, and that no public chunk imports one.
          codeSplitting: {
            groups: [
              {
                // Vite's import() preload helper is shared by every module that loads
                // code lazily, public ones included (the RUM beacon). Its own neutral
                // chunk, claimed first: inside admin-ui it made public pages import an
                // admin chunk (caught by scripts/admin-bundle.mjs).
                name: 'preload-helper',
                test: (id) => id.includes('preload-helper'),
                priority: 60,
              },
              {
                name: 'admin-vendor',
                test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/,
                priority: 50,
              },
              {
                // What every admin script needs and nothing more: the sign-in page loads
                // this (the fetch helper) instead of the whole admin.
                name: 'admin-client',
                test: /[\\/]src[\\/]lib[\\/]admin[\\/](client|toast|confirm|icons)\.ts$/,
                priority: 40,
              },
              {
                // The rich-text editor and its ProseMirror stack (~100 KB gz). Lazy:
                // FormField imports RichText with import(), so only a form that has a
                // rich-text field downloads it.
                name: 'admin-rich',
                test: /[\\/](node_modules[\\/](@tiptap|prosemirror-|orderedmap|rope-sequence|w3c-keyname|linkifyjs)|src[\\/]components[\\/]admin[\\/]RichText\.tsx$)/,
                priority: 30,
              },
              {
                // Our own admin-only modules, and what they need (zod, the schemas).
                name: 'admin-ui',
                test: /[\\/]src[\\/](components|lib)[\\/]admin[\\/]/,
                priority: 20,
              },
              {
                // The two video helpers, as ONE chunk. Each is shared (lazyVideo by the
                // hero, the slogan band and MediaBanner; clips by lazyVideo and
                // MediaFrame), so Rolldown gave each its own file, and every page with a
                // hero loaded a three-deep module waterfall — Hero → lazyVideo → clips —
                // each hop a full round trip that Lighthouse's LCP simulation counted
                // (the /ar home: the last node of the LCP graph was clips.js; S2 perf
                // note in docs/design-port-2026-09.md). Every page that loads lazyVideo
                // loads clips anyway; a MediaFrame-only page pays ~1 KB more.
                name: 'media-client',
                test: /[\\/]src[\\/]lib[\\/]client[\\/](lazyVideo|clips)\.ts$/,
                priority: 10,
              },
            ],
          },
        },
      },
    },
  },

  integrations: [react()],

  // Astro's Markdown pipeline is NOT a render path in this project — there is not one
  // .md/.mdx file in src/, and blog bodies are Tiptap JSON rendered by
  // src/lib/content/tiptap.ts, which emits `<pre><code class="language-…">` with no
  // inline styles (the language is re-derived from an allowlist, never passed through).
  // Left at its default of 'shiki', Astro warns on every boot that Shiki's inline styles
  // are incompatible with `security.csp` above — a warning about code that never runs.
  // Turning it off states the intent and keeps the boot output free of noise nobody
  // should learn to scroll past. Code-block styling is ours, via `.language-*` in CSS.
  markdown: { syntaxHighlight: false },

  // The dev toolbar cannot work under the CSP above and never could: it builds its UI by
  // assigning inline styles at RUNTIME (`updateStyle`, `createWindowElement`), and a
  // style injected by JS after load can be covered by neither a build-time hash nor a
  // per-request nonce. So it renders unstyled in a corner and emits a violation per
  // widget on every page load — dozens of console lines that are pure noise. That noise
  // is not free: it is what buried the three real violations that proved no island was
  // hydrating. Off, so the console only says things worth reading.
  devToolbar: { enabled: false },

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
  security: {
    checkOrigin: true,

    // Pillar 1 (CSP), the other half of the `assetsInlineLimit: 0` fix above.
    // `assetsInlineLimit` only governs COMPONENT scripts. Every hydrated island also
    // emits four inline elements Astro writes itself and never nonces — the island
    // <style>, the client:* directive script, the `astro-island` custom-element
    // definition, and the framework hydration script (see astro's render/component.js:
    // `<style>…</style><script>…</script><script>…</script>`). Under our
    // no-'unsafe-inline' CSP the browser blocks all four, the custom element is never
    // defined, and EVERY admin island renders server-side and then stays dead. Enabling
    // this makes Astro hash them; src/lib/http/securityHeaders.ts lifts those hashes
    // into our own policy rather than clobbering them.
    //
    // Every route in this app is `prerender = false`, so Astro's CSP always arrives as a
    // response header (it only falls back to <meta> for prerendered pages) — which
    // matters, because `frame-ancestors` is ignored in a <meta> CSP and §3 requires it.
    csp: { algorithm: 'SHA-256' },
  },

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
