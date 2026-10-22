import type { Locale } from '@schemas/primitives';
import { PUBLIC_SITE_URL } from 'astro:env/client';
import { getPageComposition } from '@/lib/data/pageSections';
import { getPublishedDisciplines } from '@/lib/data/disciplines';
import { getFaq } from '@/lib/data/faq';
import { buildBreadcrumbSchema, buildFaqSchema, type JsonLdNode } from '@/lib/seo/jsonld';
import { localizedPath } from '@/lib/i18n';
import { loadHead, type Head } from '@/lib/seo/head';
import { PAGE_META } from '@/lib/seo/pageMeta';
import { DEFAULT_CONTACT_SECTIONS, ensureContactInquiry, withHeroPreset } from './types';
import { faqShown, withContactData } from './contact';
import type { SectionData } from './types';

// The data behind Contact (`/contact`, `/ar/contact`), one loader shared by both twins (UI v2
// PR9; Admin v2 U7 for the FAQ). It ran in ContactPage.astro until Admin v2 R7, which moved it
// here so the ROUTE holds the sections before it sets its headers: a composed page's
// Cache-Tag adds what its sections read (src/lib/sections/reads.ts), and a header set from a
// component's frontmatter may already be sent. The reads, their order and the HTML are as
// before.
//
// Route-level guarantees on top of whatever the CMS says:
//   withHeroPreset('contact')  the hero is the contact banner with the contact copy;
//   ensureContactInquiry       the inquiry form (the one public write path) cannot be hidden
//                              or removed;
//   withContactData            the published disciplines and their services reach the form
//                              as route data (its grouped select, Round 2), and the published
//                              FAQ reaches the FAQ band (Admin v2 U7).

export interface ContactPageData {
  sections: SectionData[];
  head: Head;
  jsonLd: JsonLdNode[];
}

type Locals = Parameters<typeof loadHead>[0];

const HOME = { en: 'Home', ar: 'الرئيسية' } as const;

export async function loadContactPage(locals: Locals, locale: Locale): Promise<ContactPageData> {
  const meta = PAGE_META.contact[locale];
  // The composition, the head (whose per-page SEO override needs the page id, so it is handed
  // the composition query rather than its result), the disciplines and the FAQ load together.
  const compositionQuery = getPageComposition('contact');
  const [composition, head, groups, faq] = await Promise.all([
    compositionQuery,
    loadHead(locals, {
      locale,
      fallbackTitle: meta.title,
      fallbackDescription: meta.description,
      entity: compositionQuery.then((c) => (c ? { type: 'page' as const, id: c.page.id } : null)),
    }),
    getPublishedDisciplines(),
    getFaq(locale),
  ]);
  // A published page with no sections yet renders the default composition (its SEO override,
  // keyed by the page id above, still applies).
  const composed = composition?.sections.length ? composition.sections : DEFAULT_CONTACT_SECTIONS;
  const sections = withContactData(ensureContactInquiry(withHeroPreset(composed, 'contact')), {
    groups,
    faq,
  });

  const base = PUBLIC_SITE_URL.replace(/\/$/, '');
  const breadcrumb = buildBreadcrumbSchema([
    { name: HOME[locale], url: base + localizedPath('/', locale) },
    { name: meta.title, url: base + localizedPath('/contact', locale) },
  ]);
  // FAQPage, built from the SAME array FaqAccordion renders (one getFaq read, handed to both;
  // src/lib/data/faq.ts), and only while the FAQ band renders: a visible FAQ section and at
  // least one published question. If the two ever disagree, the structured data describes
  // content the page does not visibly contain, which is a manual-action category.
  const jsonLd = faqShown(sections, faq) ? [breadcrumb, buildFaqSchema(faq)] : [breadcrumb];
  return { sections, head, jsonLd };
}
