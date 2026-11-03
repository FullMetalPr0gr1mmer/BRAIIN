// The loading screen's Lighthouse re-gate (Admin v2 E7; README's E7 row: "lhci re-gate"): sets
// the home page's intro to one style in the job's LOCAL Supabase, with the bar, a tagline in
// both languages and the longest timing (1.5 s hold, .6 s fade: the plate covers the page the
// longest), then checks the preview renders that plate, so the run that follows
// (lighthouserc.intro.json, `npm run lhci:intro`) measures `/` and `/ar`, the only pages with
// the plate, wearing it. `reset` puts the intro back as built (the five columns at their
// defaults), so the themed run after it measures what it measured before E7.
//
// LOCAL ONLY. It writes with the service role key the CI job exports for its own stack, and
// refuses any Supabase or preview that is not loopback (lhci-theme.mjs's rule), so it can never
// write to a hosted project. The row goes in through PostgREST, so the loading screen
// migration's CHECKs judge it as they judge every save.
//
//   node scripts/lhci-intro.mjs video|black|light|reset
//        (PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PREVIEW_URL; perf-seo-a11y.yml's
//         lighthouse job)

import { pathToFileURL } from 'node:url';
import { isLoopback } from './lhci-theme.mjs';

export const INTRO_STYLES = ['video', 'black', 'light'];

/** The intro as built: the five columns' defaults (the loading screen migration). */
export const INTRO_AS_BUILT = {
  intro_backdrop: 'video',
  intro_bar: false,
  intro_tagline: null,
  intro_hold_ms: 1000,
  intro_fade_ms: 450,
};

/** The intro columns the run sets for one style (or, for `reset`, the intro as built). */
export function introRunColumns(style) {
  if (style === 'reset') return { ...INTRO_AS_BUILT };
  if (!INTRO_STYLES.includes(style)) {
    throw new Error(`lhci-intro: the style is one of ${INTRO_STYLES.join(', ')} or reset`);
  }
  return {
    intro_backdrop: style,
    intro_bar: true,
    intro_tagline: { en: 'From the brain to the real world.', ar: 'من الفكرة إلى الواقع.' },
    intro_hold_ms: 1500,
    intro_fade_ms: 600,
  };
}

/** The opening tag of the plate a page serves ('' for none). */
export function plateOf(html) {
  return /<div class="intro"[^>]*>/.exec(String(html ?? ''))?.[0] ?? '';
}

/** The plate the run expects on the home page for one style (or as built, for `reset`). */
export function expectedPlate(style) {
  if (style === 'reset') return '<div class="intro" aria-hidden="true">';
  const backdrop = style === 'video' ? '' : ` data-backdrop="${style}"`;
  return `<div class="intro" aria-hidden="true"${backdrop} data-hold="1500" data-fade="600">`;
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const style = argv[0] ?? '';
  const columns = introRunColumns(style);
  const supabase = String(env.PUBLIC_SUPABASE_URL ?? '').replace(/\/$/, '');
  const preview = String(env.PREVIEW_URL ?? 'http://localhost:8788').replace(/\/$/, '');
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!isLoopback(supabase) || !isLoopback(preview)) {
    throw new Error('lhci-intro: refusing a Supabase or preview that is not loopback');
  }
  if (!key) throw new Error('lhci-intro: SUPABASE_SERVICE_ROLE_KEY is not set');

  // The launch tenant's row: tenant_id defaults to app.effective_tenant_id(), the launch tenant
  // for a token that names none (the service role's). Created on the first run, updated after.
  const res = await fetch(`${supabase}/rest/v1/site_appearance?on_conflict=tenant_id`, {
    method: 'POST',
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify(columns),
  });
  if (!res.ok) {
    throw new Error(`lhci-intro: the look was refused (${res.status}): ${await res.text()}`);
  }
  console.log(`lhci-intro: the intro is ${style}`);

  // The preview renders it, in both languages, before Lighthouse measures anything.
  const want = expectedPlate(style);
  for (const path of ['/', '/ar']) {
    const html = await (await fetch(`${preview}${path}`)).text();
    const plate = plateOf(html);
    if (plate !== want) {
      throw new Error(`lhci-intro: ${path} serves ${plate || 'no plate'}, expected ${want}`);
    }
    const extras = style !== 'reset';
    if (html.includes('class="intro__tag"') !== extras) {
      throw new Error(`lhci-intro: ${path} ${extras ? 'lacks' : 'still has'} the tagline`);
    }
    console.log(`lhci-intro: ${path} serves ${plate}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
