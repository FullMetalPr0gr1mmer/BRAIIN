import type { Locale } from '@schemas/primitives';
import { PUBLIC_SITE_URL } from 'astro:env/client';
import { isCustomPageSectionType, isCustomPageSlug } from '@schemas/customPages';
import { getPageComposition, type PageComposition } from '@/lib/data/pageSections';
import { loadHead, type Head } from '@/lib/seo/head';
import { buildBreadcrumbSchema, buildWebPageSchema, type JsonLdNode } from '@/lib/seo/jsonld';
import { localizedPath, pickLocale, pickLocaleStrict } from '@/lib/i18n';
import { pagePathOf } from '@/lib/visibility/routes';
import { HERO_PRESETS, type SectionData } from './types';

// The data behind a custom page (Admin v2 E11; `/<slug>` and `/ar/<slug>`, src/pages/[slug].astro
// and src/pages/ar/[slug].astro), one loader shared by both twins, as Contact's is. The ROUTE
// holds the sections before it sets its headers, so its Cache-Tag adds what they read.
//
// In order:
//   1. the slug is a custom page's address (packages/schemas/customPages.ts), or the route
//      answers its 404 having read NOTHING: a probe for /wp-login or /.env costs no query, and
//      a reserved word or a route slug (`/home`) never reaches the database;
//   2. the page, published, with its sections, through the one public loader
//      (getPageComposition: anon under RLS, a password page's unlocked read inside its scope);
//      no published page is the 404 too. The head's reads start beside it (its SEO override is
//      keyed by the page id), so the page costs one round trip, not two;
//   3. route-level rules on whatever the CMS says (customSections):
//        only the custom set renders  a type a custom page cannot hold (written around the
//                                     API) renders nothing;
//        the first hero is a banner   no intro plate, the loop's contact window, its button to
//                                     Our Work (the built-in label says "See our work");
//        a heading, always            with no visible heading section the page opens with a
//                                     banner hero titled with the page's own title, so it has
//                                     exactly one <h1>.
//   4. JSON-LD: WebPage and its BreadcrumbList (Home > the page), in the page's language.

export interface CustomPageData {
  page: PageComposition['page'];
  sections: SectionData[];
  head: Head;
  jsonLd: JsonLdNode[];
  /** The page's English path (`/<slug>`): the layout's logical path. */
  path: string;
}

type Locals = Parameters<typeof loadHead>[0];

const HOME = { en: 'Home', ar: 'الرئيسية' } as const;

/** The sections that render a page's <h1> (the editor's heading group, library.ts). */
const HEADING_TYPES: readonly string[] = ['hero', 'aboutStory', 'aboutWho', 'pageHead'];

/** The banner every custom page's first hero wears: route data, never content. */
export const CUSTOM_HERO_DATA = {
  banner: true,
  ctaHref: '/portfolio',
  clip: HERO_PRESETS.contact.data.clip,
} as const;

// Hero.astro's own ladder (packages/schemas/sections.ts HERO_MAX_WORDS, HERO_MAX_WORD_LEN):
// the entrance animates one word or letter per rung, so a headline past it would not show.
const HERO_MAX_WORDS = 10;
const HERO_MAX_WORD_LEN = 14;

/**
 * A title as the floor hero's headline: at most ten words of at most fourteen characters
 * (per code point, as Hero.astro splits them). The New page dialog asks for a title that fits,
 * so this clips only a title edited longer since.
 */
export function heroHeadlineOf(title: string): string {
  return title
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, HERO_MAX_WORDS)
    .map((word) => [...word].slice(0, HERO_MAX_WORD_LEN).join(''))
    .join(' ');
}

/**
 * The route-level rules on a custom page's composition (step 3 above). Pure. `title` is the
 * page's own, both languages: the floor hero's headline, in the page's language each.
 */
export function customSections(
  authored: readonly SectionData[],
  title: { en: string; ar: string },
): SectionData[] {
  const sections = authored.filter((s) => isCustomPageSectionType(s.type));
  const headed = sections.some((s) => s.visible !== false && HEADING_TYPES.includes(s.type));
  const floor: SectionData[] = headed
    ? []
    : [
        {
          type: 'hero',
          props: {
            headline: {
              en: heroHeadlineOf(title.en),
              ar: heroHeadlineOf(title.ar || title.en),
            },
          },
        },
      ];
  let dressed = false;
  return [...floor, ...sections].map((s) => {
    // The first hero only (a hidden one counts: it is the one the editor calls the banner).
    if (dressed || s.type !== 'hero') return s;
    dressed = true;
    return { ...s, data: { ...s.data, ...CUSTOM_HERO_DATA } };
  });
}

/** The words of a rich-text document, in order, as one line (a description's source). */
export function docText(doc: unknown, limit = 400): string {
  const out: string[] = [];
  let length = 0;
  const walk = (node: unknown): void => {
    if (length >= limit || typeof node !== 'object' || node === null) return;
    const { type, text, content } = node as { type?: unknown; text?: unknown; content?: unknown };
    if (type === 'text' && typeof text === 'string') {
      out.push(text);
      length += text.length;
      return;
    }
    if (Array.isArray(content)) {
      for (const child of content as unknown[]) walk(child);
      // A block ends a sentence's run: a space between paragraphs and list items.
      out.push(' ');
    }
  };
  walk(doc);
  return out.join('').replace(/\s+/g, ' ').trim();
}

/** At most `max` characters, cut at a word, with an ellipsis when cut. */
function clip(text: string, max = 160): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const at = cut.lastIndexOf(' ');
  return `${(at > 80 ? cut.slice(0, at) : cut).trimEnd()}…`;
}

/**
 * The page's own description, for a page with no SEO override: the first words it shows, in
 * its language only (a text block's body, else a hero's line under the headline), never the
 * other language's (pickLocaleStrict's rule for metadata). Empty when it shows none, and the
 * head then falls back to the site's default description.
 */
export function customDescription(sections: readonly SectionData[], locale: Locale): string {
  for (const s of sections) {
    if (s.visible === false) continue;
    const props = (s.props ?? {}) as Record<string, unknown>;
    if (s.type === 'textBlock') {
      const body = props['body'] as Record<string, unknown> | undefined;
      const words = docText(body?.[locale]);
      if (words) return clip(words);
    }
    if (s.type === 'hero') {
      const sub = pickLocaleStrict(props['sub'] as { en: string; ar?: string } | undefined, locale);
      if (sub.trim()) return clip(sub.trim());
    }
  }
  return '';
}

/**
 * Everything a custom page renders, or null for its 404: not a custom page's address, no such
 * page, or not published (step 1 and 2 above).
 */
export async function loadCustomPage(
  locals: Locals,
  locale: Locale,
  slug: string | undefined,
): Promise<CustomPageData | null> {
  if (!isCustomPageSlug(slug)) return null;
  const compositionQuery = getPageComposition(slug);
  const [composition, head] = await Promise.all([
    compositionQuery,
    loadHead(locals, {
      locale,
      fallbackTitle: compositionQuery.then((c) => (c ? pickLocale(c.page.title, locale) : '')),
      fallbackDescription: compositionQuery.then((c) =>
        c ? customDescription(c.sections, locale) : '',
      ),
      entity: compositionQuery.then((c) => (c ? { type: 'page' as const, id: c.page.id } : null)),
    }),
  ]);
  // The loader answers the row it was asked for (citext): only the address as stored renders.
  if (!composition || composition.page.slug.toLowerCase() !== slug) return null;

  const { page } = composition;
  const sections = customSections(composition.sections, page.title);
  const path = pagePathOf(slug);
  const base = PUBLIC_SITE_URL.replace(/\/$/, '');
  const name = pickLocale(page.title, locale, slug);
  const url = base + localizedPath(path, locale);
  const description = head.seo.description;
  const jsonLd = [
    buildWebPageSchema({
      name,
      url,
      siteUrl: base,
      locale,
      ...(description ? { description } : {}),
      ...(page.updatedAt ? { dateModified: page.updatedAt } : {}),
    }),
    buildBreadcrumbSchema([
      { name: HOME[locale], url: base + localizedPath('/', locale) },
      { name, url },
    ]),
  ];
  return { page, sections, head, jsonLd, path };
}
