import { z } from 'zod';
import type { Locale } from '@schemas/primitives';
import { fromPreviewPath, previewRouteOf, splitLocale } from '@/lib/admin/preview/paths';

// What one `/admin/preview/**` request renders (Admin v2 R9; releases.md §6.3 item 5). The
// preview renders the PUBLIC route itself, through Astro's rewrite inside the content scope
// (src/lib/http/preview.ts), so this maps a preview URL to the public path to rewrite to
// and nothing more: the page files stay the one implementation of every page, and the parity
// e2e compares the two renders of that one implementation.
//
// The query string goes along (a catalogue filter, a form's `?status=`), except the
// preview's own parameter, `only` (the publish dialog's selection of pending changes).

/** At most this many pending changes in one `only` selection (a release is capped near 60). */
export const PREVIEW_ONLY_MAX = 500;

const OnlySchema = z.array(z.string().uuid()).min(1).max(PREVIEW_ONLY_MAX);

export interface PreviewTarget {
  /** The public path and query Astro renders (`/ar/services/logo?x=1`). */
  publicPath: string;
  /** Its pathname alone. */
  pathname: string;
  /** The path without its language prefix (`/services/logo`). */
  logical: string;
  locale: Locale;
  /** The route pattern it renders, in its English form (`/services/[slug]`). */
  route: string;
  /** The `only` selection, when the request names one. */
  only?: readonly string[];
}

export type PreviewTargetResult =
  { ok: true; target: PreviewTarget } | { ok: false; reason: 'not-previewed' | 'bad-selection' };

/** A preview URL → what it renders, or why it renders nothing. */
export function previewTarget(url: URL): PreviewTargetResult {
  const pathname = fromPreviewPath(url.pathname);
  const route = pathname === null ? null : previewRouteOf(pathname);
  if (pathname === null || route === null) return { ok: false, reason: 'not-previewed' };

  const params = new URLSearchParams(url.search);
  const rawOnly = params.getAll('only');
  params.delete('only');
  let only: readonly string[] | undefined;
  if (rawOnly.length > 0) {
    const ids = rawOnly.flatMap((v) => v.split(',')).filter((v) => v.length > 0);
    const parsed = OnlySchema.safeParse(ids);
    if (!parsed.success) return { ok: false, reason: 'bad-selection' };
    only = [...new Set(parsed.data.map((id) => id.toLowerCase()))];
  }
  const search = params.toString();
  const { locale, logical } = splitLocale(pathname);
  return {
    ok: true,
    target: {
      publicPath: search ? `${pathname}?${search}` : pathname,
      pathname,
      logical,
      locale,
      route,
      ...(only ? { only } : {}),
    },
  };
}

/** A page's twin in the other language (`/about` ↔ `/ar/about`, `/` ↔ `/ar`). */
export function twinPath(target: Pick<PreviewTarget, 'locale' | 'logical'>): string {
  if (target.locale === 'ar') return target.logical;
  return target.logical === '/' ? '/ar' : `/ar${target.logical}`;
}
