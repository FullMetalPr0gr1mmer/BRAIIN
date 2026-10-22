import type { Locale } from '@schemas/primitives';
import type { ApplyStatus } from '@schemas/application';
import { PUBLIC_SITE_URL } from 'astro:env/client';
import { getPageComposition } from '@/lib/data/pageSections';
import { buildBreadcrumbSchema, type JsonLdNode } from '@/lib/seo/jsonld';
import { localizedPath } from '@/lib/i18n';
import { loadHead, type Head } from '@/lib/seo/head';
import { PAGE_META } from '@/lib/seo/pageMeta';
import { composeJoinPage, firstVisibleType, shown } from './join';
import type { SectionData } from './types';

// The data behind Join (`/join`, `/ar/join`), one loader shared by both twins. It ran in
// JoinPage.astro until Admin v2 R7, which moved it here so the ROUTE holds the sections before
// it sets its headers (a composed page's Cache-Tag adds what its sections read,
// src/lib/sections/reads.ts). The reads, their order and the HTML are as before.
//
// Route-level guarantees on top of whatever the CMS says (src/lib/sections/join.ts):
//   withHeroPreset('join')  the banner hero with the join copy and loop window, its CTA
//                           pointing at #apply;
//   ensureJoinApply         the application band (the form) cannot be hidden or removed;
//   withJoinData            the no-JS answer reaches the form as route data.

export interface JoinPageData {
  sections: SectionData[];
  head: Head;
  jsonLd: JsonLdNode[];
  /**
   * `overlay` only while the page opens on its dark banner hero: an editor who hides the hero
   * would otherwise put a white-on-white header over the white "Why" band.
   */
  header: 'overlay' | 'solid';
  /** With no visible hero there is no visible h1, so a visually hidden one stands in. */
  hiddenH1: boolean;
}

type Locals = Parameters<typeof loadHead>[0];

const HOME = { en: 'Home', ar: 'الرئيسية' } as const;

export async function loadJoinPage(
  locals: Locals,
  locale: Locale,
  answer: ApplyStatus | null,
): Promise<JoinPageData> {
  const meta = PAGE_META.join[locale];
  // The composition and the head (whose per-page SEO override needs the page id, so it is
  // handed the composition query rather than its result) load together.
  const compositionQuery = getPageComposition('join');
  const [composition, head] = await Promise.all([
    compositionQuery,
    loadHead(locals, {
      locale,
      fallbackTitle: meta.title,
      fallbackDescription: meta.description,
      entity: compositionQuery.then((c) => (c ? { type: 'page' as const, id: c.page.id } : null)),
    }),
  ]);
  const sections = composeJoinPage(composition?.sections ?? [], answer);
  const base = PUBLIC_SITE_URL.replace(/\/$/, '');
  return {
    sections,
    head,
    jsonLd: [
      buildBreadcrumbSchema([
        { name: HOME[locale], url: base + localizedPath('/', locale) },
        { name: meta.title, url: base + localizedPath('/join', locale) },
      ]),
    ],
    header: firstVisibleType(sections) === 'hero' ? 'overlay' : 'solid',
    hiddenH1: !shown(sections, 'hero'),
  };
}
