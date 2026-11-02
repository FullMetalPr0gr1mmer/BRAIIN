import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  CUSTOM_PAGE_SECTION_TYPES,
  CUSTOM_PAGE_SLUG_MAX,
  CUSTOM_PAGE_TYPE_REFUSED,
  RESERVED_PAGE_SLUGS,
  ROUTE_PAGE_SLUGS,
  customPageSlugProblem,
  isCustomPageSectionType,
  isCustomPageSlug,
  suggestPageSlug,
} from '@schemas/customPages';
import { PageSlugSchema, PageWriteSchema, SectionWriteSchema } from '@schemas/admin';
import { SECTION_TYPES } from '@schemas/sectionTypes';
import { sectionContentIssues, type SectionType } from '@schemas/sections';
import { PAGE_PATHS } from '@/lib/visibility/routes';
import { sectionResource } from '@/lib/admin/resources';
import { pageResource } from '@/lib/admin/resources/pages';
import { translateWriteError } from '@/lib/admin/crud';
import { ValidationError } from '@/lib/admin/errors';
import type { OverlayDb } from '@/lib/release/overlayDb';
import type { AuthContext } from '@/lib/auth/types';
import { buildWebPageSchema } from '@/lib/seo/jsonld';
import { customPageCacheEntities, TIER_A_ROUTES } from '@/lib/http/routeTags';
import { GA4_ROUTES } from '@/lib/http/ga4';
import { tierATags } from '@/lib/http/cacheTags';
import { SECTION_READS } from '@/lib/sections/reads';
import { pagePath } from '@/lib/seo/entityPaths';
import { indexability, isIndexedPath } from '@/lib/seo/indexable';
import * as newPageModel from '@/components/admin/screens/newPage/model';
import { SECTION_KINDS } from '@/components/admin/screens/pageEditor/library';

const { addBanner, bannerMissing, heroPayload, newPageErrors, newPagePayload, titleProblem } =
  newPageModel;

vi.mock('astro:env/client', () => ({ PUBLIC_SITE_URL: 'https://www.example.test' }));

const {
  CUSTOM_HEADING_TYPES,
  CUSTOM_HERO_DATA,
  customDescription,
  customSections,
  docText,
  heroHeadlineOf,
} = await import('@/lib/sections/customPage');

// Custom pages (Admin v2 E11; docs/admin-v2/as-built/E11.md): the address rules, held to the
// site's own files and to 0123's SQL; the route-level rules on a custom page's sections; its
// head and JSON-LD; the API's refusal of a type a custom page cannot hold; the New page dialog.

const doc = (...paras: string[]) => ({
  type: 'doc',
  content: paras.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
});

describe('the address rules', () => {
  it('the route slugs are the route map’s, and no reserved word is one', () => {
    expect([...ROUTE_PAGE_SLUGS].sort()).toEqual(Object.keys(PAGE_PATHS).sort());
    for (const word of RESERVED_PAGE_SLUGS) {
      expect((ROUTE_PAGE_SLUGS as readonly string[]).includes(word), word).toBe(false);
    }
    expect(new Set(RESERVED_PAGE_SLUGS).size).toBe(RESERVED_PAGE_SLUGS.length);
  });

  it('every top-level route of src/pages and folder of public/ is a route slug or reserved', () => {
    const taken = new Set<string>([...ROUTE_PAGE_SLUGS, ...RESERVED_PAGE_SLUGS]);
    const segments = new Set<string>();
    // src/pages/ar too (E11 review E11-SEC-2): a custom page also renders at /ar/<slug>, and an
    // Arabic-only route there would silently shadow its twin.
    for (const dir of ['src/pages', 'src/pages/ar']) {
      for (const name of readdirSync(dir)) {
        const bare = name.replace(/\.(astro|ts)$/, '').replace(/\.[a-z]+$/, '');
        // The catch-all and `[slug]` routes (this slice's, U14's) are not addresses.
        if (/^\[/.test(bare)) continue;
        segments.add(bare);
      }
    }
    for (const name of readdirSync('public')) {
      if (statSync(join('public', name)).isDirectory()) segments.add(name);
    }
    expect(segments.size).toBeGreaterThan(15);
    for (const segment of segments) {
      // A segment no custom page could take anyway (a dot, an underscore) needs no word.
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(segment)) continue;
      expect(taken.has(segment) || segment === 'index', segment).toBe(true);
      expect(isCustomPageSlug(segment), segment).toBe(false);
    }
  });

  it('0123 refuses exactly the reserved words, in the same shape and length', () => {
    const sql = readFileSync('supabase/migrations/0123_custom_pages.sql', 'utf8');
    const fn = /create or replace function app\.tg_pages_slug_rules\(\)[\s\S]*?end \$\$;/.exec(
      sql,
    )?.[0];
    expect(fn, 'the rule is in 0123').toBeDefined();
    const list = /v_slug = any \(array\[([^\]]+)\]\)/.exec(fn!)?.[1] ?? '';
    const words = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(words.sort()).toEqual([...RESERVED_PAGE_SLUGS].sort());
    expect(fn).toContain(`not between 1 and ${CUSTOM_PAGE_SLUG_MAX}`);
    expect(fn).toContain("'^[a-z0-9]+(-[a-z0-9]+)*$'");
    expect(sql).toMatch(
      /create trigger pages_slug_rules before insert or update of slug on public\.pages\s+for each row/,
    );
  });

  it('a custom page’s address: lowercase words and single hyphens, at most 64, never taken', () => {
    for (const ok of ['our-story', 'a', '2026-offers', 'a'.repeat(CUSTOM_PAGE_SLUG_MAX)]) {
      expect(customPageSlugProblem(ok), ok).toBeNull();
    }
    for (const bad of [
      '',
      'Our-Story',
      'our--story',
      'our_story',
      '-story',
      'story-',
      'our story',
      'a'.repeat(CUSTOM_PAGE_SLUG_MAX + 1),
      'about',
      'home',
      'portfolio-all',
      'admin',
      'api',
      'ar',
      'media',
      'cdn-cgi',
    ]) {
      expect(isCustomPageSlug(bad), bad).toBe(false);
      expect(customPageSlugProblem(bad), bad).toMatch(/\.$/);
    }
    expect(isCustomPageSlug(undefined)).toBe(false);
  });

  it('the page write schema refuses a reserved word and a long address, and keeps route slugs', () => {
    expect(PageSlugSchema.safeParse('our-story').success).toBe(true);
    expect(PageSlugSchema.safeParse('about').success).toBe(true);
    expect(PageSlugSchema.safeParse('admin').success).toBe(false);
    expect(PageSlugSchema.safeParse('a'.repeat(CUSTOM_PAGE_SLUG_MAX + 1)).success).toBe(false);
    const create = PageWriteSchema.safeParse({ slug: 'search', title: { en: 'S', ar: 'س' } });
    expect(create.success).toBe(false);
    expect(create.error?.issues[0]?.path).toEqual(['slug']);
  });

  it('0123’s refusals and the unique key reach the editor on the address, in plain words', () => {
    for (const [constraint, words] of [
      ['pages_slug_shape', /lowercase letters/],
      ['pages_slug_reserved', /already uses/],
    ] as const) {
      const error = translateWriteError(
        {
          code: '23514',
          message: 'x',
          details: `Failing row violates check constraint "${constraint}".`,
        },
        'pages',
        'write',
        pageResource.constraintFields,
      );
      expect(error, constraint).toMatchObject({ field: 'slug' });
      expect(error.message, constraint).toMatch(words);
    }
    const taken = translateWriteError(
      {
        code: '23505',
        message: 'duplicate key value violates unique constraint "pages_tenant_id_slug_key"',
        details: 'Key (tenant_id, slug)=(x, y) already exists.',
      },
      'pages',
      'write',
      pageResource.constraintFields,
    );
    expect(taken).toMatchObject({ field: 'slug' });
    expect(taken.message).toMatch(/Another page already has this address/);
  });

  it('suggests an address from an English title', () => {
    expect(suggestPageSlug('Our Story')).toBe('our-story');
    expect(suggestPageSlug('  Café & Co. — 2026!  ')).toBe('cafe-co-2026');
    expect(suggestPageSlug('من نحن')).toBe('');
    expect(suggestPageSlug('word '.repeat(40)).length).toBeLessThanOrEqual(CUSTOM_PAGE_SLUG_MAX);
  });
});

describe('the sections a custom page holds', () => {
  it('the set is section types, and every one is told what it reads', () => {
    for (const type of CUSTOM_PAGE_SECTION_TYPES) {
      expect(SECTION_TYPES as readonly string[], type).toContain(type);
      expect(SECTION_READS[type], type).toBeDefined();
    }
    // Nothing that holds a form or another page's data.
    for (const type of ['contact', 'contactInquiry', 'hello', 'joinApply', 'faq', 'projectGrid']) {
      expect(isCustomPageSectionType(type), type).toBe(false);
    }
  });

  it('no section of the set renders a form (so a custom page may load GA4, src/lib/http/ga4.ts)', () => {
    // SectionRenderer's map: `type: Component`, and each component's import path.
    const renderer = readFileSync('src/components/SectionRenderer.astro', 'utf8');
    const files = new Map(
      [...renderer.matchAll(/^import (\w+) from '@\/components\/sections\/(\w+\.astro)';$/gm)].map(
        (m) => [m[1]!, join('src/components/sections', m[2]!)],
      ),
    );
    const formIn = (file: string, depth = 0): boolean => {
      const source = readFileSync(file, 'utf8');
      if (/<form\b/.test(source)) return true;
      // One level of the components it imports (a form component, a band holding one).
      if (depth > 0) return false;
      return [...source.matchAll(/from '@\/components\/([\w/]+\.astro)'/g)].some((m) =>
        formIn(join('src/components', m[1]!), depth + 1),
      );
    };
    // The scan sees a form where one is: Contact's inquiry section holds one.
    expect(formIn(files.get('ContactInquiry')!)).toBe(true);
    expect(GA4_ROUTES.has('/[slug]') && GA4_ROUTES.has('/ar/[slug]')).toBe(true);
    for (const type of CUSTOM_PAGE_SECTION_TYPES) {
      const component = new RegExp(`^\\s+${type}: (\\w+),$`, 'm').exec(renderer)?.[1];
      expect(component, type).toBeDefined();
      const file = files.get(component!);
      expect(file, type).toBeDefined();
      expect(formIn(file!), `${type} (${file})`).toBe(false);
    }
  });

  const title = { en: 'Our story', ar: 'قصتنا' };

  it('only the set renders; the first hero is the banner; a page with no heading gets one', () => {
    const out = customSections(
      [
        { type: 'contactInquiry' },
        { type: 'textBlock', props: { body: { en: doc('x'), ar: doc('س') } } },
        { type: 'hero', props: { headline: { en: 'Hi', ar: 'هلا' } } },
        { type: 'hero' },
      ],
      title,
    );
    expect(out.map((s) => s.type)).toEqual(['textBlock', 'hero', 'hero']);
    expect(out[1]?.data).toEqual(CUSTOM_HERO_DATA);
    expect(out[2]?.data).toBeUndefined();
    expect(CUSTOM_HERO_DATA).toMatchObject({ banner: true, ctaHref: '/portfolio' });
  });

  it('with no visible heading, the page opens with a banner of its own title', () => {
    for (const authored of [[], [{ type: 'hero', visible: false }], [{ type: 'textBlock' }]]) {
      const out = customSections(authored, title);
      expect(out[0]).toMatchObject({
        type: 'hero',
        props: { headline: { en: 'Our story', ar: 'قصتنا' } },
        data: CUSTOM_HERO_DATA,
      });
    }
    // An Arabic title left empty falls back to the English one rather than an empty <h1>.
    expect(customSections([], { en: 'Hi', ar: '' })[0]?.props).toEqual({
      headline: { en: 'Hi', ar: 'Hi' },
    });
  });

  it('a title too long for the banner’s ladder is clipped to fit', () => {
    expect(heroHeadlineOf('one two three four five six seven eight nine ten eleven')).toBe(
      'one two three four five six seven eight nine ten',
    );
    expect(heroHeadlineOf('Supercalifragilistic')).toBe(
      'Supercalifrag'.padEnd(14, 'i').slice(0, 14),
    );
    expect([...heroHeadlineOf('Supercalifragilistic')].length).toBe(14);
  });

  it('describes the page with its first words, in its own language only', () => {
    const sections = [
      { type: 'hero', props: { sub: { en: 'A line.', ar: '' } } },
      { type: 'textBlock', props: { body: { en: doc('First words.', 'More.'), ar: doc('كلام') } } },
    ];
    expect(customDescription(sections, 'en')).toBe('A line.');
    expect(customDescription(sections, 'ar')).toBe('كلام');
    expect(customDescription([], 'en')).toBe('');
    expect(customDescription([{ type: 'textBlock', visible: false, props: {} }], 'en')).toBe('');
    const long = customDescription(
      [{ type: 'textBlock', props: { body: { en: doc('word '.repeat(80)), ar: doc('x') } } }],
      'en',
    );
    expect(long.length).toBeLessThanOrEqual(160);
    expect(long.endsWith('…')).toBe(true);
    expect(docText(doc('a', 'b'))).toBe('a b');
  });

  // H15's rule for a Tiptap body: the bounded walk first, then no recursion. A body the section
  // walk refuses has no words, as TextBlock renders none of it, and nothing in it can throw.
  it('reads a body only through the section walk, without recursion', () => {
    const list = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'One' }] },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two' }] }],
            },
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'three' }] }],
            },
          ],
        },
      ],
    };
    expect(docText(list)).toBe('One two three');
    // The limit stops the read at the run of words that reaches it.
    expect(docText(doc('abcd', 'efgh', 'ijkl'), 6)).toBe('abcd efgh');
    let deep: Record<string, unknown> = { type: 'text', text: 'deep' };
    for (let i = 0; i < 100_000; i += 1) deep = { type: 'blockquote', content: [deep] };
    const bomb = { type: 'doc', content: [deep] };
    expect(() => docText(bomb)).not.toThrow();
    expect(docText(bomb)).toBe('');
    // Outside the section walk's model (an h1, an image): no words, as the page shows none.
    const h1 = {
      type: 'doc',
      content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Big' }] }],
    };
    expect(docText(h1)).toBe('');
    expect(docText({ type: 'doc', content: [{ type: 'image', attrs: { src: '/x.png' } }] })).toBe(
      '',
    );
    expect(
      customDescription([{ type: 'textBlock', props: { body: { en: bomb, ar: bomb } } }], 'en'),
    ).toBe('');
  });
});

// E11 code review CR8: the heading floor counts only heading types a custom page can hold.
describe('the heading floor', () => {
  it('is the editor’s heading group within the custom set', () => {
    expect([...CUSTOM_HEADING_TYPES].sort()).toEqual(
      CUSTOM_PAGE_SECTION_TYPES.filter((t) => SECTION_KINDS[t].group === 'heading').sort(),
    );
  });
});

describe('the seeded sample page (H15: the strict section write)', () => {
  const seed = JSON.parse(
    readFileSync(join(process.cwd(), 'supabase/seed-data/57-custom-page.json'), 'utf8'),
  ) as { blocks: { table: string; rows: { type: string; content: unknown }[] }[] };
  const rows = seed.blocks.filter((b) => b.table === 'page_sections').flatMap((b) => b.rows);

  it('holds a section of each kind it shows', () => {
    expect(rows.map((r) => r.type)).toEqual(['hero', 'textBlock']);
  });

  for (const row of rows) {
    it(`its ${row.type} is a type a custom page holds, with only keys its type has`, () => {
      expect(isCustomPageSectionType(row.type)).toBe(true);
      expect(sectionContentIssues(row.type as SectionType, row.content)).toEqual([]);
    });
  }
});

describe('the head, the tags and the listings', () => {
  it('WebPage: name, its own URL, its language, the site, and only real optional fields', () => {
    const node = buildWebPageSchema({
      name: 'قصتنا',
      url: 'https://x/ar/our-story',
      siteUrl: 'https://x/',
      locale: 'ar',
    });
    expect(node).toEqual({
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      name: 'قصتنا',
      url: 'https://x/ar/our-story',
      inLanguage: 'ar',
      isPartOf: { '@type': 'WebSite', url: 'https://x' },
    });
    expect(
      buildWebPageSchema({
        name: 'n',
        url: 'u',
        siteUrl: 's',
        locale: 'en',
        description: 'd',
        dateModified: '2026-11-02T00:00:00Z',
      }),
    ).toMatchObject({ description: 'd', dateModified: '2026-11-02T00:00:00Z' });
  });

  it('a custom page is tagged by its slug and fits a purge with every section it may hold', () => {
    expect(customPageCacheEntities('our-story')).toEqual(['page:our-story', 'media:all']);
    expect(TIER_A_ROUTES.find((r) => r.route === 'page')).toMatchObject({ composed: true });
    const every = CUSTOM_PAGE_SECTION_TYPES.flatMap((t) => SECTION_READS[t]);
    const tags = tierATags({
      route: 'page',
      locale: 'ar',
      entities: [...customPageCacheEntities('a'.repeat(64)), ...every],
    });
    expect(tags.length).toBeLessThanOrEqual(30);
    expect(tags).toContain(`page:${'a'.repeat(64)}`);
  });

  it('its path is /<slug>, and a static route’s SEO row rule finds its page by that path', () => {
    expect(pagePath('our-story')).toBe('/our-story');
    expect(pagePath('admin')).toBeNull();
    const ix = indexability(
      {
        rules: [
          { entity_type: 'page', entity_id: 'p1', robots: 'noindex', canonical_override: null },
        ],
        pages: [{ id: 'p1', slug: 'our-story' }],
      },
      null,
    );
    expect(isIndexedPath(ix, '/our-story', 'https://x')).toBe(false);
    expect(isIndexedPath(ix, '/other', 'https://x')).toBe(true);
  });
});

describe('the section routes hold the set on a custom page', () => {
  const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const PAGE = '22222222-2222-4222-8222-222222222222';
  const auth = { tenantId: TENANT, userId: PAGE, role: 'admin' } as unknown as AuthContext;
  const pageDb = (slug: string | null) => {
    const asked: unknown[] = [];
    const db = {
      first: async (table: string, query: unknown) => {
        asked.push({ table, query });
        return slug === null ? null : { id: PAGE, slug };
      },
      list: async () => [],
    } as unknown as OverlayDb;
    return { db, asked };
  };
  type R = Record<string, unknown>;
  const check = (merged: R, changed: R, db: OverlayDb, before: R | null = null) =>
    sectionResource.assertWritable!(merged, { auth, sb: {} as never, changed, db, before });

  it('refuses a type a custom page cannot hold, on the type field, in plain words', async () => {
    const row = { page_id: PAGE, type: 'contactInquiry', content: {} };
    const { db, asked } = pageDb('our-story');
    const refused = check(row, row, db);
    await expect(refused).rejects.toBeInstanceOf(ValidationError);
    await expect(refused).rejects.toMatchObject({
      field: 'type',
      detail: CUSTOM_PAGE_TYPE_REFUSED,
    });
    expect(asked).toEqual([
      { table: 'pages', query: { columns: 'id,slug', eq: { id: PAGE }, limit: 1 } },
    ]);
  });

  it('takes the same type on a route page, and a type of the set anywhere without a read', async () => {
    const row = { page_id: PAGE, type: 'contactInquiry', content: {} };
    await expect(check(row, row, pageDb('contact').db)).resolves.toBeUndefined();
    const hero = { page_id: PAGE, type: 'hero', content: {} };
    const quiet = pageDb('our-story');
    await expect(check(hero, hero, quiet.db)).resolves.toBeUndefined();
    expect(quiet.asked).toEqual([]);
  });

  it('an edit that keeps a row’s type and page reads nothing (the form sends type every save)', async () => {
    const row = { page_id: PAGE, type: 'faq', content: {} };
    const { db, asked } = pageDb('our-story');
    await expect(check(row, { type: 'faq' }, db, row)).resolves.toBeUndefined();
    expect(asked).toEqual([]);
  });
});

describe('the New page dialog', () => {
  const input = { titleEn: 'Our  story', titleAr: 'قصتنا', slug: 'our-story' };

  it('asks for a title that fits the banner, in both languages, and a free address', () => {
    expect(newPageErrors(input)).toEqual({});
    expect(titleProblem('', 'Arabic')).toMatch(/in Arabic/);
    expect(titleProblem('a b c d e f g h i j k', 'English')).toMatch(/10 words/);
    expect(titleProblem('Supercalifragilistic', 'English')).toMatch(/14 letters/);
    expect(newPageErrors({ ...input, slug: 'about' }).slug).toMatch(/already uses/);
    expect(newPageErrors({ ...input, slug: 'admin' }).slug).toMatch(/already uses/);
    expect(Object.keys(newPageErrors({ titleEn: '', titleAr: '', slug: 'X' })).sort()).toEqual([
      'slug',
      'titleAr',
      'titleEn',
    ]);
  });

  // E11 code review CR9: one rule for the address, the module's, never a copy of it here.
  it('says the address’s refusal in the module’s words, from the one rule', () => {
    expect(Object.keys(newPageModel)).not.toContain('slugProblem');
    for (const slug of ['', 'about', 'home', 'admin', 'Our-Story', 'a'.repeat(65), 'our-story']) {
      expect(newPageErrors({ ...input, slug }).slug, slug).toBe(
        customPageSlugProblem(slug) ?? undefined,
      );
    }
  });

  // E11 code review CR4: the page made and its banner refused is said, reported and retried,
  // never swallowed.
  it('a banner refused is reported through the client error channel and handed back', async () => {
    let posts = 0;
    const reports: string[] = [];
    const refusal = new Error('Validation failed: headline');
    const outcome = await addBanner(PAGE_ID, {
      post: async () => {
        posts += 1;
        throw refusal;
      },
      report: (message) => reports.push(message),
    });
    expect(outcome).toEqual({ added: false, error: refusal });
    expect(posts).toBe(1);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain(PAGE_ID);
    expect(reports[0]).toContain('Validation failed: headline');
    // The title is the editor's words, not the log's.
    expect(reports[0]).not.toContain('Our');
    expect(bannerMissing('it was refused')).toMatch(
      /^The page was made as a draft, but its banner/,
    );
    const added = await addBanner(PAGE_ID, {
      post: async () => {
        posts += 1;
        return {};
      },
      report: (message) => reports.push(message),
    });
    expect(added).toEqual({ added: true });
    expect(posts).toBe(2);
    expect(reports).toHaveLength(1);
  });

  it('the dialog has no silent catch', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/components/admin/screens/newPage/NewPage.tsx'),
      'utf8',
    );
    // A `catch` whose block holds nothing but comments says nothing to anyone.
    expect(src).not.toMatch(/catch\s*(\([^)]*\))?\s*\{\s*(\/\/[^\n]*\s*)*\}/);
  });

  it('makes a draft page, then its banner hero titled with the page’s title, both valid writes', () => {
    const page = newPagePayload(input);
    expect(page).toEqual({
      slug: 'our-story',
      title: { en: 'Our story', ar: 'قصتنا' },
      status: 'draft',
    });
    expect(PageWriteSchema.safeParse(page).success).toBe(true);
    const hero = heroPayload(PAGE_ID, input);
    expect(hero).toMatchObject({
      type: 'hero',
      visible: true,
      content: { headline: page['title'] },
    });
    expect(SectionWriteSchema.safeParse(hero).success).toBe(true);
  });
});

const PAGE_ID = '22222222-2222-4222-8222-222222222299';
