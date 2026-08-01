// Refuses to build a deployable artifact with a non-production PUBLIC_SITE_URL.
//
// WHY THIS EXISTS — the failure it prevents is silent and expensive.
//
// `PUBLIC_SITE_URL` is declared `context: 'client', access: 'public'` in astro.config.mjs,
// so `astro:env/client` INLINES it into the bundle at build time. It is imported by 18
// files — <SeoHead>, sitemap.xml, robots.txt, llms.txt, both RSS feeds, and every
// detail/index page's JSON-LD — i.e. every canonical, every hreflang, every og:url, every
// <loc>, and the Sitemap: pointer robots.txt hands to crawlers.
//
// The trap: `wrangler.jsonc` also lists PUBLIC_SITE_URL under `vars`, which reads like
// runtime configuration and is NOT. A var that is inlined at build cannot be overridden
// by the runtime environment, so the wrangler value is inert and the value present when
// `astro build` ran is the one that ships — permanently, in the artifact. Measured, not
// assumed: a Worker built with .env's localhost and deployed with wrangler.jsonc set to
// the workers.dev origin served `<link rel="canonical" href="http://localhost:4321/">`
// and a sitemap of localhost <loc>s.
//
// Nothing about that fails loudly. The site is up, every page renders, and the only
// symptom is that Google is told the canonical version of every page lives on a host that
// does not resolve. By the time that is visible in Search Console the crawl has happened.
//
// So: default-deny, with an explicit, greppable opt-out for local preview builds.
//
//   npm run build                          → guarded
//   ALLOW_LOCAL_SITE_URL=1 npm run build   → local `astro preview` / wrangler dev

import { readFileSync, existsSync } from 'node:fs';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

/**
 * Mirror Vite's dotenv precedence for `mode=production`, highest first. The guard has to
 * resolve the value the same way the BUILD will, or it guards a different string than the
 * one that gets compiled in — which is worse than no guard, because it reports a pass.
 *
 * Shell env is checked first but is NOT sufficient on its own: an inline
 * `PUBLIC_SITE_URL=… npm run build` reaches the SSR page modules but was measured NOT to
 * reach the client-env inlining used by the admin chunk, leaving a build with both values
 * in it. `.env.production` is the file that every path agrees on.
 */
const ENV_FILES = ['.env.production.local', '.env.production', '.env.local', '.env'];

function readSiteUrl() {
  if (process.env['PUBLIC_SITE_URL']) {
    return { value: process.env['PUBLIC_SITE_URL'].trim(), from: 'shell environment' };
  }
  for (const file of ENV_FILES) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^PUBLIC_SITE_URL=(.*)$/);
      if (m) return { value: (m[1] ?? '').trim(), from: file };
    }
  }
  return { value: '', from: 'nowhere' };
}

function fail(reason, detail) {
  console.error(`\n  ✘ build blocked — PUBLIC_SITE_URL ${reason}`);
  if (detail) console.error(`    ${detail}`);
  console.error(`
    PUBLIC_SITE_URL is inlined into the bundle at build time (astro:env/client) and is
    what 18 files use to build canonicals, hreflang, og:url, JSON-LD, the sitemap and the
    robots.txt Sitemap pointer. Setting it in wrangler.jsonc "vars" does NOT work — that
    value is inert for build-time env. It must be correct in the BUILD environment.

      PUBLIC_SITE_URL=https://your-origin.example npm run build

    For a local preview build, opt out explicitly:

      ALLOW_LOCAL_SITE_URL=1 npm run build
`);
  process.exit(1);
}

const { value: raw, from: source } = readSiteUrl();
const escapeHatch = process.env['ALLOW_LOCAL_SITE_URL'] === '1';

if (!raw) fail('is not set', `Checked: shell env, then ${ENV_FILES.join(', ')}.`);

let url;
try {
  url = new URL(raw);
} catch {
  fail('is not a valid absolute URL', `got: ${raw}`);
}

const isLocal = LOCAL_HOSTS.has(url.hostname) || url.hostname.endsWith('.local');
const isInsecure = url.protocol !== 'https:';

if (escapeHatch) {
  console.log(`  ⚠ PUBLIC_SITE_URL=${raw} (from ${source}) — allowed via ALLOW_LOCAL_SITE_URL=1.`);
  console.log('    This artifact is NOT deployable: its canonicals point at that origin.');
  process.exit(0);
}

if (isLocal) fail('points at a local host', `got: ${raw}`);
// http:// is allowed only for a local host, which the check above has already rejected.
if (isInsecure) fail('is not https', `got: ${raw}`);

console.log(`  ✓ PUBLIC_SITE_URL=${raw}  (from ${source})`);
