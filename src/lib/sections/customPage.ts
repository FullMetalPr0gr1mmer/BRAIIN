import type { Locale } from '@schemas/primitives';
import { PUBLIC_SITE_URL } from 'astro:env/client';
import { isCustomPageSectionType, isCustomPageSlug } from '@schemas/customPages';
import { sectionDocProblem } from '@schemas/tiptap';
import { getPageComposition, type PageComposition } from '@/lib/data/pageSections';
import { latestInstant } from '@/lib/data/parse';
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
//      answers its 404 having read NOTHING: a URL that cannot be a page's address (`/.env`,
//      `/wp-login.php`, `/Our-Story`), a reserved word or a route slug (`/home`) never
//      reaches the database;
//   2. the page, published, with its sections, through the one public loader
//      (getPageComposition: anon under RLS, a password page's unlocked read inside its scope);
//      no published page is the 404 too. A free address that is no page (`/wp-admin`) costs
//      that one read and nothing more: the head's reads (seo_defaults, the page's SEO
//      override) start only once the page is found (E11 review E11-C3), as the 404 page skips
//      them for every probe. One round trip more on a found page, which the edge caches;
//   3. route-level rules on whatever the CMS says (customSections):
//        only the custom set renders  a type a custom page cannot hold (written around the
//                                     API) renders nothing;
//        the first hero is a banner   no intro plate, the loop's contact window, its button to
//                                     Our Work (the built-in label says "See our work");
//        a heading, always            with no visible heading section the page opens with a
//                                     banner hero titled with the page's own title, so it has
//                                     exactly one <h1>.
//   4. JSON-LD: WebPage and its BreadcrumbList (Home > the page), in the page's language;
//      `dateModified` is when what the page shows last changed (its row or a section it
//      renders, customModifiedAt);
//   5. the header: the overlay only while the page opens on its banner hero (customHeader).

export interface CustomPageData {
  page: PageComposition['page'];
  sections: SectionData[];
  head: Head;
  jsonLd: JsonLdNode[];
  /** The page's English path (`/<slug>`): the layout's logical path. */
  path: string;
  /** The layout's header (customHeader). */
  header: 'overlay' | 'solid';
}

type Locals = Parameters<typeof loadHead>[0];

const HOME = { en: 'Home', ar: 'الرئيسية' } as const;

/**
 * The sections of the custom set that render a page's <h1>: the editor's heading group
 * (library.ts) within CUSTOM_PAGE_SECTION_TYPES, which only the hero is in (E11 code review,
 * CR8: the other heading types never reach a custom page). tests/lib/customPages.spec.ts holds
 * it equal to the editor's group over the set.
 */
export const CUSTOM_HEADING_TYPES: readonly string[] = ['hero'];

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
  const headed = sections.some((s) => s.visible !== false && CUSTOM_HEADING_TYPES.includes(s.type));
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

/**
 * The header a custom page wears (E11 review E11-C1): the transparent overlay only while the
 * first section a visitor sees is its dark banner hero. An editor may move the hero below a
 * text block (a hero has no pin), and the fixed white overlay would then sit white on white
 * over the paper block; Services and Join make the same choice (joinPage.ts, firstVisibleType).
 */
export function customHeader(sections: readonly SectionData[]): 'overlay' | 'solid' {
  return sections.find((s) => s.visible !== false)?.type === 'hero' ? 'overlay' : 'solid';
}

/**
 * When what a custom page shows last changed (Admin v2 E11 review E11-C2, code review CR6): the
 * later of its row's `updated_at` and those of the sections it RENDERS (`customSections`' output,
 * shown ones only), never a row the page drops (a type outside the set, a row that did not
 * parse). The floor hero is the page's own title, dated by the row. A removed or hidden section
 * leaves no date behind.
 */
export function customModifiedAt(
  page: { updatedAt: string | null },
  rendered: readonly SectionData[],
): string | null {
  return latestInstant([
    page.updatedAt,
    ...rendered.filter((s) => s.visible !== false).map((s) => s.updatedAt),
  ]);
}

/** Where a block's words end, on docText's stack: a space between paragraphs and list items. */
const BLOCK_END: unique symbol = Symbol('block end');

/**
 * The words of a Text block's body, in order, as one line (a description's source). The body
 * goes through the section walk first (`sectionDocProblem`, packages/schemas/tiptap.ts: at most
 * 300 nodes and 8 levels, H15's rule for a Tiptap body) and is then read with a stack, never
 * recursion; a body the walk refuses has no words here, as TextBlock renders none of it.
 */
export function docText(doc: unknown, limit = 400): string {
  if (sectionDocProblem(doc) !== null) return '';
  const out: string[] = [];
  let length = 0;
  const stack: unknown[] = [doc];
  while (stack.length > 0 && length < limit) {
    const node = stack.pop();
    if (node === BLOCK_END) {
      out.push(' ');
      continue;
    }
    if (typeof node !== 'object' || node === null) continue;
    const { type, text, content } = node as { type?: unknown; text?: unknown; content?: unknown };
    if (type === 'text' && typeof text === 'string') {
      out.push(text);
      length += text.length;
      continue;
    }
    if (Array.isArray(content)) {
      stack.push(BLOCK_END);
      for (let i = content.length - 1; i >= 0; i -= 1) stack.push(content[i]);
    }
  }
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
  const composition = await getPageComposition(slug);
  // The loader answers the row it was asked for (citext): only the address as stored renders.
  if (!composition || composition.page.slug.toLowerCase() !== slug) return null;

  const { page } = composition;
  const head = await loadHead(locals, {
    locale,
    fallbackTitle: pickLocale(page.title, locale),
    fallbackDescription: customDescription(composition.sections, locale),
    entity: { type: 'page', id: page.id },
  });
  const sections = customSections(composition.sections, page.title);
  const path = pagePathOf(slug);
  const base = PUBLIC_SITE_URL.replace(/\/$/, '');
  const name = pickLocale(page.title, locale, slug);
  const url = base + localizedPath(path, locale);
  const description = head.seo.description;
  const modifiedAt = customModifiedAt(page, sections);
  const jsonLd = [
    buildWebPageSchema({
      name,
      url,
      siteUrl: base,
      locale,
      ...(description ? { description } : {}),
      ...(modifiedAt ? { dateModified: modifiedAt } : {}),
    }),
    buildBreadcrumbSchema([
      { name: HOME[locale], url: base + localizedPath('/', locale) },
      { name, url },
    ]),
  ];
  return { page, sections, head, jsonLd, path, header: customHeader(sections) };
}
