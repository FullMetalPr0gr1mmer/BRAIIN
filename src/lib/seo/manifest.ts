import type { APIContext } from 'astro';
import type { Locale } from '@schemas/primitives';
import { getIdentity, getSiteIcons } from '@/lib/identity';
import { manifestIcons } from './siteIcons';

// The web app manifest, `/manifest.webmanifest` and `/ar/manifest.webmanifest` (Admin v2 U9):
// the name, the tagline and the home-screen icons, in the page's language. Linked from the
// head only when an app icon is set (src/components/SeoHead.astro); it answers 200 either way,
// with no icon an empty list.
//
// `display: 'browser'` (decision D7): this is a marketing site, not an app to install, so it
// asks for no standalone window and no install prompt. The colours are the public theme's
// midnight and paper (public/styles/global.css --bs-midnight, --bs-paper), written here until
// the theme editor (E4) makes them data.
//
// Tier A: public, edge-cached an hour like llms.txt, tagged with the identity and media so a
// purge on publish reaches it.

export const MANIFEST_THEME_COLOR = '#000d30';
export const MANIFEST_BACKGROUND_COLOR = '#ffffff';

export interface WebManifest {
  name: string;
  short_name: string;
  description?: string;
  lang: Locale;
  dir: 'ltr' | 'rtl';
  start_url: string;
  scope: string;
  display: 'browser';
  background_color: string;
  theme_color: string;
  icons: { src: string; sizes: string; type: 'image/png' }[];
}

export async function webManifest(locals: App.Locals, locale: Locale): Promise<WebManifest> {
  const [identity, icons] = await Promise.all([getIdentity(locals), getSiteIcons(locals)]);
  const start = locale === 'ar' ? '/ar/' : '/';
  const tagline = identity.tagline?.[locale];
  return {
    name: identity.brandName[locale],
    short_name: identity.brandName[locale],
    ...(tagline ? { description: tagline } : {}),
    lang: locale,
    dir: locale === 'ar' ? 'rtl' : 'ltr',
    start_url: start,
    scope: start,
    display: 'browser',
    background_color: MANIFEST_BACKGROUND_COLOR,
    theme_color: MANIFEST_THEME_COLOR,
    icons: await manifestIcons(icons),
  };
}

/** The route's answer. */
export async function manifestResponse(context: Pick<APIContext, 'locals'>, locale: Locale) {
  const body = JSON.stringify(await webManifest(context.locals, locale));
  return new Response(body, {
    headers: {
      'content-type': 'application/manifest+json; charset=utf-8',
      'cache-control': 'public, max-age=3600',
      'cache-tag': `route:manifest,locale:${locale},site:identity,media:all`,
    },
  });
}
