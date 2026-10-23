// @ts-check
import { defineConfig, envField } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
// Phase 3: the React integration is registered for the /admin islands. Public pages
// still ship ZERO React — Astro only emits the runtime for routes that actually
// hydrate an island, and the `codeSplitting` groups below put that runtime in
// `admin-vendor-*.js` so the public 100 KB budget keeps measuring only public JS.
import react from '@astrojs/react';
// Admin v2 U3: `image.remotePatterns` = this build's public `media` bucket, derived from
// PUBLIC_SUPABASE_URL (the build fails without it). See the script's header.
import { mediaRemotePatternsIntegration } from './scripts/media-remote-patterns.mjs';
// The `/_image` endpoint: the guard on the route itself, uploads checked before they are
// transformed and cached for an hour, stills handed to the adapter (the script's header).
import { imageEndpointIntegration } from './scripts/image-endpoint.mjs';

// The component kit's own modules (Admin v2 F4b): its React pieces
// (src/components/admin/kit/), the vanilla client code (src/lib/admin/client/: the
// Sortable core, and the enhancers AdminLayout's script will lazy-load), and the two
// models in src/lib/admin/ that only kit code reaches in the browser (roving.ts: Tabs and
// the Sortable core's arrow keys; avatar.ts: the Avatar's tone). Claimed by admin-ui's
// path rule they rode on every screen; here they join admin-ui only when a screen there
// imports them, like any kit piece.
const ADMIN_KIT =
  /[\\/]src[\\/](components[\\/]admin[\\/]kit[\\/]|lib[\\/]admin[\\/](client[\\/]|(roving|avatar)\.ts$))/;
// The kit's reference screen (/admin/kit): its island and that island's own code, which
// stay in the island's `AdminKit` entry chunk.
const ADMIN_KIT_SCREEN =
  /[\\/]src[\\/]components[\\/]admin[\\/](screens[\\/]kit[\\/]|islands[\\/]AdminKit\.tsx$)/;
// The field kit and the editors built on it (Admin v2 F5a): the field renderer and its
// components, the payload shaping, the section editor's descriptors, the error mapping, the
// save machine and its hook, and the two forms that use them. Claimed by admin-ui's path
// rule they rode on every screen, a list or a dashboard included (12.1 KB gz each, measured
// in F5a); here they are their own group, which only an editor's island loads. Nothing in
// admin-ui may import them, and admin-ui leaves the two editor islands alone
// (ADMIN_EDITOR_ISLANDS): a group takes its modules' static dependencies, and admin-ui's
// path rule also matches an island's entry module, so either would pull the field kit
// back into admin-ui (tests/lib/adminBundle.spec.ts checks both). Admin v2 U8b: the shared SEO
// editor (SeoPanel and its GooglePreview, screens/seo/) is the field kit's too, since every
// tabbed editor's SEO tab draws it (ResourceForm imports it), and so are the tabs' rules
// (editorTabs.ts); left in the SEO screen's group, every editor would import admin-screens.
const ADMIN_FIELDS =
  /[\\/]src[\\/](components[\\/]admin[\\/](FormField\.tsx$|fields[\\/]|screens[\\/](resources[\\/]ResourceForm|singleton[\\/]SingletonForm|seo[\\/](SeoPanel|GooglePreview))\.tsx$)|lib[\\/]admin[\\/](formPayload|sectionUi|fieldErrors|fieldValues|entitySave|useEntitySave|saveMode|contrast|accentWords|linkables|editorTabs)\.ts$)/;
// The dashboard (Admin v2 U1): its island's eager code (Dashboard.tsx) stays in the island's
// `AdminDashboard` entry chunk, and what it loads on first use (the Customize binder, the
// drawers and modals) is the admin-dashboard group. Claimed by admin-ui's path rule, they and
// the kit pieces they draw with rode on every admin screen (about 10 KB gz each, measured in
// U1).
const ADMIN_DASHBOARD_SCREEN =
  /[\\/]src[\\/]components[\\/]admin[\\/](screens[\\/]dashboard[\\/]|islands[\\/]AdminDashboard\.tsx$)/;
const ADMIN_DASHBOARD_LAZY =
  /[\\/]src[\\/]components[\\/]admin[\\/]screens[\\/]dashboard[\\/](AddWidgetDrawer|QuickActionsDrawer|RoleDefaultsModal|ResetModal|customize)\.tsx?$/;
// The islands whose static graph reaches the field kit, and their screens' directories
// (Admin v2 U4, Wave 3's chunk rule): admin-ui's path rule would otherwise claim them, and a
// group takes its modules' static dependencies, so admin-ui would import admin-fields and the
// field kit would ride on every admin screen (F5a measured 12.1 KB gz each). One name per
// line, sorted: a later slice adds its island and its screen directory here, a line each.
// prettier-ignore
const ADMIN_EDITOR_ISLAND_NAMES = [
  'AdminCollection',
  'AdminCrmSettings',
  'AdminGeneral',
  'AdminIntegrations',
  'AdminMaintenance',
  'AdminMediaLibrary',
  'AdminNotificationSettings',
  'AdminResourceForm',
  'AdminSeo',
  'AdminSingletonForm',
];
// prettier-ignore
const ADMIN_EDITOR_SCREEN_DIRS = [
  'collection',
  'crmSettings',
  'general',
  'integrations',
  'maintenance',
  'media',
  'notificationSettings',
  'seo',
];
/** @param {readonly string[]} names */
const alternatives = (names) => names.join('|');
const ADMIN_EDITOR_ISLANDS = new RegExp(
  String.raw`[\\/]src[\\/]components[\\/]admin[\\/]islands[\\/](${alternatives(ADMIN_EDITOR_ISLAND_NAMES)})\.tsx$`,
);
const ADMIN_EDITOR_SCREENS = new RegExp(
  String.raw`[\\/]src[\\/]components[\\/]admin[\\/]screens[\\/](${alternatives(ADMIN_EDITOR_SCREEN_DIRS)})[\\/]`,
);
// F5a's two editor islands keep their own entry chunks: each is a one-line entry over
// admin-fields, and in the shared group below every editor screen would load the other
// screens' code with it.
const ADMIN_SELF_NAMED_EDITORS =
  /[\\/]src[\\/]components[\\/]admin[\\/]islands[\\/]Admin(ResourceForm|SingletonForm)\.tsx$/;
// Where the islands admin-ui leaves go (Wave 3's chunk rule, critique 6): one shared group
// for every island entry and screen module no other group claims, so a module a screen
// reaches only through import() still lands in an admin-* file instead of a module-named
// chunk, which size-limit would weigh as public JavaScript. A later slice joins it by its
// path alone.
const ADMIN_SCREENS =
  /[\\/]src[\\/]components[\\/]admin[\\/](islands[\\/]Admin[^\\/]*\.tsx$|screens[\\/])/;
// The leads screens (Admin v2 C4b): the three islands and their screen code, in their own
// group, so the list, the board and a lead's page share one chunk and no other admin screen
// loads it. The add drawer and the erase dialog are reached only through import(): their own
// lazy group (ADMIN_LEADS_LAZY), below the field kit, so a first load never carries them.
const ADMIN_LEADS =
  /[\\/]src[\\/]components[\\/]admin[\\/](screens[\\/]leads[\\/]|islands[\\/]AdminLead)/;
const ADMIN_LEADS_LAZY =
  /[\\/]src[\\/]components[\\/]admin[\\/]screens[\\/]leads[\\/](AddLeadDrawer|EraseLeadDialog)\.tsx$/;
// The releases preview's bridge (Admin v2 R9, P-4): the code a `/admin/preview/**` render
// loads (src/components/preview/AdminPreviewBridge.astro). Its own group, never in admin-ui,
// which every admin screen loads.
const ADMIN_PREVIEW = /[\\/]src[\\/]lib[\\/]admin[\\/]preview[\\/]/;
// What the bridge shares with admin-ui (R9 pre-merge review): zod and the preview envelope
// with its theme tokens. Claimed above admin-ui, so the bridge imports them from this chunk
// and never admin-ui, whose static graph is React (admin-vendor) and the admin helpers:
// about 120 KB gz a preview render loaded and never ran (scripts/admin-bundle.mjs check 7).
const ADMIN_ZOD =
  /[\\/](node_modules[\\/]zod[\\/]|packages[\\/]schemas[\\/](previewMessage|themeTokens)\.ts$)/;
// A kit piece both the kit's reference screen and a screen group draw (C4b: the React KPI
// card, in the gallery and on the leads list): in admin-ui, so neither the AdminKit entry nor
// the group's chunk imports the other's. Small (under 1 KB gz) and shared, like any kit piece
// an admin-ui screen draws.
const ADMIN_KIT_SHARED = /[\\/]src[\\/]components[\\/]admin[\\/]kit[\\/]Kpi\.tsx$/;
// The shared admin-ui chunk claims none of these by path. A group also takes its modules' static
// dependencies, so a kit piece still lands in admin-ui the moment a screen there imports
// it; the rest of the kit goes to the lowest admin group, `admin-kit`, instead of riding
// along on every admin screen.

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
          // shared helpers, then the rich-text editor, then everything else admin, and
          // last the component kit's modules none of those took (F4b).
          //
          // Why named at all: `.size-limit.json` splits public from admin by FILE NAME,
          // so an admin module in an anonymous chunk would be weighed against the public
          // 100 KB budget. Every admin chunk is `admin-*` (and every island entry
          // `Admin*`). scripts/admin-bundle.mjs checks the real build (`npm run size`,
          // after the build in CI): what each chunk holds, that the editor is lazy, and
          // that no public chunk imports one. tests/lib/adminBundle.spec.ts tests that
          // script on fixture chunks; nothing in `npm test` reads a build.
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
                // zod and the preview envelope (R9): shared by admin-ui and the preview
                // bridge, which must not import admin-ui (React) to reach them.
                name: 'admin-zod',
                test: ADMIN_ZOD,
                priority: 25,
              },
              {
                // Our own admin-only modules, and what they need (the schemas),
                // except the component kit and its reference screen (F4b).
                name: 'admin-ui',
                test: (id) =>
                  ADMIN_KIT_SHARED.test(id) ||
                  (/[\\/]src[\\/](components|lib)[\\/]admin[\\/]/.test(id) &&
                    !ADMIN_KIT.test(id) &&
                    !ADMIN_KIT_SCREEN.test(id) &&
                    !ADMIN_DASHBOARD_SCREEN.test(id) &&
                    !ADMIN_FIELDS.test(id) &&
                    !ADMIN_EDITOR_ISLANDS.test(id) &&
                    !ADMIN_EDITOR_SCREENS.test(id) &&
                    !ADMIN_LEADS.test(id) &&
                    !ADMIN_PREVIEW.test(id)),
                priority: 20,
              },
              {
                // The preview bridge (R9): only a preview render loads it.
                name: 'admin-preview',
                test: ADMIN_PREVIEW,
                priority: 19,
              },
              {
                // The leads screens (Admin v2 C4b): below admin-ui, so what both use stays in
                // admin-ui and this chunk imports it from there; above the field kit, which no
                // leads module reaches statically (tests/lib/adminBundle.spec.ts).
                name: 'admin-leads',
                test: (id) => ADMIN_LEADS.test(id) && !ADMIN_LEADS_LAZY.test(id),
                priority: 17,
              },
              {
                // The field kit and the editors (F5a): below admin-ui, so a module both
                // use (the API client, the descriptors, zod) stays in admin-ui and this
                // chunk imports it from there; above the kit, so the kit pieces the fields
                // draw with (Segmented, Modal, the Sortable core) come with them.
                name: 'admin-fields',
                test: ADMIN_FIELDS,
                priority: 15,
              },
              {
                // The leads screens' lazy pieces (C4b): Add a lead and Erase, loaded on first
                // use. Below the field kit, so a kit piece they share with it stays there.
                name: 'admin-leads-lazy',
                test: ADMIN_LEADS_LAZY,
                priority: 14,
              },
              {
                // The screens admin-ui leaves (Admin v2 U4, Wave 3's chunk rule): an island
                // whose graph reaches the field kit, and its screen's own code. Below the
                // field kit, so what both use stays in admin-fields and this chunk imports
                // it from there; the kit's reference screen, the dashboard's island and F5a's
                // two editor entries keep their own chunks.
                name: 'admin-screens',
                test: (id) =>
                  ADMIN_SCREENS.test(id) &&
                  !ADMIN_KIT_SCREEN.test(id) &&
                  !ADMIN_DASHBOARD_SCREEN.test(id) &&
                  !ADMIN_SELF_NAMED_EDITORS.test(id),
                priority: 13,
              },
              {
                // The dashboard's editing pieces (U1), reached only through import():
                // below the field kit, so the kit pieces both use (Modal, the Sortable
                // core) stay in admin-fields and this chunk imports them from there.
                name: 'admin-dashboard',
                test: ADMIN_DASHBOARD_LAZY,
                priority: 12,
              },
              {
                // The lowest admin group (Admin v2 F4b review): the kit modules admin-ui
                // leaves still land in an admin-* file. A group captures
                // static dependencies only, so a module reached only through import() (an
                // enhancer in lib/admin/client/ that AdminLayout's script lazy-loads, a kit
                // piece a screen opens on demand) would otherwise become a module-named
                // chunk, which size-limit weighs as PUBLIC JavaScript and
                // scripts/admin-bundle.mjs fails as a public chunk importing admin code.
                name: 'admin-kit',
                test: ADMIN_KIT,
                priority: 5,
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

  integrations: [react(), mediaRemotePatternsIntegration(), imageEndpointIntegration()],

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
    // No domain is allowed. The one remote source, editors' uploads in this build's public
    // `media` bucket, is added as a remote pattern by mediaRemotePatternsIntegration()
    // (Admin v2 U3), pinned to the protocol, host, port and bucket path of
    // PUBLIC_SUPABASE_URL; the `/_image` guard (src/lib/http/imageGuard.ts) admits only
    // that bucket's keys.
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
      // Admin v2 F7: true once Supabase Auth can send e-mail (owner item O-2: SMTP in the
      // dashboard, and the recovery template linking to /admin/reset, runbook §2b). Off,
      // "Forgot password?" says "Not set up" instead of pretending to send.
      AUTH_EMAIL_READY: envField.boolean({ context: 'server', access: 'public', default: false }),
      // Admin v2 G2: the uptime monitor's ids to read, "123-456" (at most five, joined by "-";
      // src/lib/health/uptime/uptimeRobot.ts checks the grammar). Unset: the account's first
      // five monitors. Not a secret: an id reads nothing without the key below.
      UPTIME_MONITOR_IDS: envField.string({ context: 'server', access: 'public', optional: true }),
      // Admin v2 R7: the Cloudflare zone whose cache a release purges by Cache-Tag (owner item
      // O-3, KAN-20). Unset, with or without the token below, the purge is "Not set up": a
      // logged no-op, and pages stay fresh because nothing caches them yet. Not a secret.
      CF_ZONE_ID: envField.string({ context: 'server', access: 'public', optional: true }),

      // ---- Server SECRETS (never client-bundled) ----
      SUPABASE_DB_POOL_URL: envField.string({ context: 'server', access: 'secret' }), // Supavisor :6543, pgbouncer=true
      SUPABASE_SERVICE_ROLE_KEY: envField.string({ context: 'server', access: 'secret' }),
      LEAD_PII_ENC_KEY: envField.string({ context: 'server', access: 'secret' }),
      AUDIT_HMAC_KEY: envField.string({ context: 'server', access: 'secret' }),
      NOTIFY_LEAD_SECRET: envField.string({ context: 'server', access: 'secret' }),
      ANTHROPIC_API_KEY: envField.string({ context: 'server', access: 'secret', optional: true }),
      // Admin v2 G2: the external uptime monitor's READ-ONLY API key (owner item O-20). Unset,
      // site health says "Not set up" and the score leaves uptime out.
      UPTIME_MONITOR_API_KEY: envField.string({
        context: 'server',
        access: 'secret',
        optional: true,
      }),
      // Admin v2 R7: a Cloudflare API token with Zone · Cache Purge on that zone only (O-3).
      CF_CACHE_PURGE_TOKEN: envField.string({
        context: 'server',
        access: 'secret',
        optional: true,
      }),
    },
  },
});
