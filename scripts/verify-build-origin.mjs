// POST-build: assert the ORIGIN that actually got compiled into the artifact.
//
// This is the check that cannot lie, and it exists because the pre-build check did.
//
// `PUBLIC_SITE_URL` is inlined by `astro:env/client` at build time into 18 SEO surfaces
// (canonical, hreflang, og:url, JSON-LD, sitemap <loc>, the robots.txt Sitemap pointer,
// both RSS feeds). The obvious ways to set it for a one-off production build DO NOT WORK
// — all three measured against the served output of the built Worker, not inferred:
//
//   PUBLIC_SITE_URL=https://x npm run build   → still serves localhost canonicals
//   .env.production                            → still serves localhost canonicals
//   wrangler.jsonc "vars"                      → inert; the value is already compiled in
//
// Only `.env` controls it. A pre-build check that reads the shell environment therefore
// reports a cheerful pass over a build that ships the wrong origin — which is strictly
// worse than no check at all, because it converts an unknown into a false assurance.
//
// So this runs AFTER the build and inspects what was produced. There is no environment
// precedence to reason about and nothing to keep in sync: if a local origin is present in
// the output, the output is not deployable, whatever any config file claims.
//
//   npm run build                          → guarded (this runs as `postbuild`)
//   ALLOW_LOCAL_SITE_URL=1 npm run build   → local preview build, warns instead

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['dist/server', 'dist/client'];
// `.dev.vars` — the adapter's local-preview secret file, not part of the uploaded bundle
// (wrangler.jsonc points `assets.directory` at dist/client).
// `wrangler.json` — the adapter's copy of wrangler.jsonc's `vars`. That block is INERT for
// build-time env by construction, so its value is documentation, not behaviour; asserting
// on it would flag the one copy that cannot affect what is served.
const SKIP_FILES = new Set(['.dev.vars', 'wrangler.json']);

// Target the VALUE BOUND TO PUBLIC_SITE_URL specifically, not any local-looking URL.
// A bundle legitimately contains unrelated localhost defaults from libraries (there is a
// `localhost:9999` in the admin chunk today), and a blocking gate that fires on those is
// a gate that gets disabled. Both spellings the build actually emits:
//   var PUBLIC_SITE_URL = "…"    ← astro:env/client inline; this is what renders
//   "PUBLIC_SITE_URL": "…"       ← Vite's import.meta.env replacement object
const SITE_URL_BINDING = /PUBLIC_SITE_URL["']?\s*[:=]\s*["']([^"']+)["']/g;
const LOCAL_HOST = /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?)(?::\d+)?/;

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (SKIP_FILES.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

const findings = new Map();
for (const root of ROOTS) {
  for (const file of walk(root)) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue; // binary asset
    }
    for (const m of text.matchAll(SITE_URL_BINDING)) {
      const value = m[1] ?? '';
      if (!LOCAL_HOST.test(value)) continue;
      const existing = findings.get(file) ?? new Set();
      existing.add(value);
      findings.set(file, existing);
    }
  }
}

if (findings.size === 0) {
  console.log(
    '  ✓ build origin verified — PUBLIC_SITE_URL is not a local origin anywhere in dist/',
  );
  process.exit(0);
}

const allowed = process.env['ALLOW_LOCAL_SITE_URL'] === '1';
const label = allowed ? '⚠' : '✘';
const stream = allowed ? console.log : console.error;

stream(`\n  ${label} PUBLIC_SITE_URL is compiled in as a LOCAL origin:\n`);
for (const [file, hits] of findings) {
  stream(`      ${file}  →  ${[...hits].join(', ')}`);
}

if (allowed) {
  console.log(`
    Allowed via ALLOW_LOCAL_SITE_URL=1. This artifact is for local preview only —
    do NOT deploy it: its canonicals, hreflang, sitemap and robots.txt all point at
    an origin that does not resolve publicly.
`);
  process.exit(0);
}

console.error(`
    These strings are COMPILED IN. They are what the deployed site will serve as its
    canonical, hreflang, og:url, sitemap <loc> and robots.txt Sitemap pointer — telling
    crawlers the real version of every page lives on a host that does not resolve.

    Setting PUBLIC_SITE_URL in the shell, in .env.production, or in wrangler.jsonc "vars"
    does NOT change this — all three were measured against the built Worker's served
    output and none of them took effect. Edit .env:

      PUBLIC_SITE_URL=https://<your-deploy-origin>

    then rebuild. For a local preview build, opt out explicitly:

      ALLOW_LOCAL_SITE_URL=1 npm run build
`);
process.exit(1);
