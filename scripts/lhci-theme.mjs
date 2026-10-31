// The themed Lighthouse run's set-up (Admin v2 E4, AV-27; README "Gates that stay green: lhci
// (+ a themed run)"): saves the theme of tests/fixtures/themedRun.json as the tenant's active
// v1 theme in the job's LOCAL Supabase, then checks the preview links it, so the run that
// follows (lighthouserc.themed.json) measures pages that carry /styles/theme.css: one more
// same-origin stylesheet in the head, whose cost to LCP, CLS and TBT is then gated like any
// page's, and whose colours Lighthouse's accessibility audit (axe) reads.
//
// LOCAL ONLY. It writes with the service role key the CI job exports for its own stack, and
// refuses any Supabase or preview that is not loopback, so it can never write to a hosted
// project. The row goes in through PostgREST, so the 0118 CHECK (custom_themes_theme_v1) judges
// it as it judges every save: a fixture that drifted from the compiler is refused here.
//
//   node scripts/lhci-theme.mjs        (PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//                                       PREVIEW_URL; perf-seo-a11y.yml's lighthouse job)

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** http on 127.0.0.1, localhost or [::1], any port, nothing after it: the job's own stack. */
export function isLoopback(url) {
  return /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?\/?$/.test(String(url ?? ''));
}

/** The theme the run sets: the fixture's settings and the tokens they compile to. */
export function themedRunRow() {
  const fixture = JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../tests/fixtures/themedRun.json', import.meta.url)),
      'utf8',
    ),
  );
  return {
    name: 'Lighthouse themed run',
    settings: fixture.settings,
    tokens: fixture.tokens,
    is_active: true,
  };
}

/** The theme links a page's markup carries. */
export function themeLinks(html) {
  return [...html.matchAll(/<link rel="stylesheet" href="(\/styles\/theme\.css\?v=\d+)">/g)].map(
    (m) => m[1],
  );
}

async function main(env = process.env) {
  const supabase = String(env.PUBLIC_SUPABASE_URL ?? '').replace(/\/$/, '');
  const preview = String(env.PREVIEW_URL ?? 'http://localhost:8788').replace(/\/$/, '');
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!isLoopback(supabase) || !isLoopback(preview)) {
    throw new Error('lhci-theme: refusing a Supabase or preview that is not loopback');
  }
  if (!key) throw new Error('lhci-theme: SUPABASE_SERVICE_ROLE_KEY is not set');

  const res = await fetch(`${supabase}/rest/v1/custom_themes`, {
    method: 'POST',
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      prefer: 'return=representation',
    },
    body: JSON.stringify(themedRunRow()),
  });
  if (!res.ok)
    throw new Error(`lhci-theme: the theme was refused (${res.status}): ${await res.text()}`);
  const [row] = await res.json();
  console.log(`lhci-theme: the active theme is version ${row?.version}`);

  // The preview links it, and serves it, before Lighthouse measures anything.
  for (const path of ['/', '/ar', '/services/logo', '/contact']) {
    const html = await (await fetch(`${preview}${path}`)).text();
    const links = themeLinks(html);
    if (links.length !== 1) throw new Error(`lhci-theme: ${path} links ${links.length} themes`);
    const sheet = await fetch(`${preview}${links[0]}`);
    const css = await sheet.text();
    if (!sheet.ok || !css.startsWith(':root{--bs-klein:')) {
      throw new Error(`lhci-theme: ${links[0]} answered ${sheet.status}`);
    }
    console.log(`lhci-theme: ${path} links ${links[0]} (${css.length} bytes)`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
