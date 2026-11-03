import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageComposition } from '@/lib/data/pageSections';
import type { SectionData } from '@/lib/sections/types';

// loadCustomPage (Admin v2 E11), with its two reads stubbed: what a custom page's route asks of
// the database, and what it renders from the answer. From the slice's review:
//   E11-C3  an address that is no page costs the page read only: the head's reads (seo_defaults
//           and the page's SEO override) start once the page is found, as the 404 page skips
//           them for every probe;
//   E11-C2  WebPage's dateModified is when what the page shows last changed (a section edit
//           never moves pages.updated_at), counting only the sections it renders (code
//           review CR6);
//   E11-C1  the overlay header only while the page opens on its banner hero.

vi.mock('astro:env/client', () => ({ PUBLIC_SITE_URL: 'https://www.example.test' }));

const db = vi.hoisted(() => ({
  composition: null as PageComposition | null,
  compositionReads: 0,
  headReads: 0,
}));
vi.mock('@/lib/data/pageSections', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getPageComposition: async () => {
    db.compositionReads += 1;
    return db.composition;
  },
}));
vi.mock('@/lib/seo/head', () => ({
  loadHead: async () => {
    db.headReads += 1;
    return { seo: { title: 'T', description: 'D', robots: 'index,follow' } };
  },
}));

const { loadCustomPage } = await import('@/lib/sections/customPage');

const PAGE = {
  id: '00000000-0000-4000-8000-00000000e110',
  slug: 'our-story',
  title: { en: 'Our story', ar: 'قصتنا' },
  updatedAt: '2026-10-01T08:00:00+00:00',
};
const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});
const HERO: SectionData = { type: 'hero', props: { headline: { en: 'Our story', ar: 'قصتنا' } } };
const TEXT: SectionData = {
  type: 'textBlock',
  props: { body: { en: doc('Words.'), ar: doc('كلمات.') } },
};

const compose = (
  sections: SectionData[],
  updatedAt: string | null = PAGE.updatedAt,
): PageComposition => ({ page: { ...PAGE, updatedAt }, sections });

beforeEach(() => {
  db.composition = null;
  db.compositionReads = 0;
  db.headReads = 0;
});

describe('an address that is no page', () => {
  it('costs the page read only, never the head’s (E11-C3)', async () => {
    for (const slug of ['wp-admin', 'wp-login', 'phpmyadmin', 'no-such-page']) {
      expect(await loadCustomPage({}, 'en', slug), slug).toBeNull();
      expect(await loadCustomPage({}, 'ar', slug), slug).toBeNull();
    }
    expect(db.compositionReads).toBe(8);
    expect(db.headReads).toBe(0);
  });

  it('one that cannot be an address costs nothing at all', async () => {
    for (const slug of ['wp-login.php', '.env', 'Our-Story', 'admin', 'home', undefined]) {
      expect(await loadCustomPage({}, 'en', slug), String(slug)).toBeNull();
    }
    expect(db.compositionReads).toBe(0);
    expect(db.headReads).toBe(0);
  });

  it('a row answered for another spelling (citext) is not this page, and reads no head', async () => {
    db.composition = compose([HERO]);
    expect(await loadCustomPage({}, 'en', 'our-storyx')).toBeNull();
    expect(db.headReads).toBe(0);
  });
});

describe('a custom page found', () => {
  it('reads its head once', async () => {
    db.composition = compose([HERO, TEXT]);
    expect(await loadCustomPage({}, 'en', PAGE.slug)).not.toBeNull();
    expect(db.compositionReads).toBe(1);
    expect(db.headReads).toBe(1);
  });

  it('dates its WebPage by its latest change, a section’s included (E11-C2)', async () => {
    const sectionEdit = '2026-10-30T12:00:00+00:00';
    db.composition = compose([HERO, { ...TEXT, updatedAt: sectionEdit }]);
    for (const locale of ['en', 'ar'] as const) {
      const page = await loadCustomPage({}, locale, PAGE.slug);
      const webPage = page?.jsonLd.find((n) => n['@type'] === 'WebPage');
      expect(webPage?.['dateModified'], locale).toBe(sectionEdit);
    }
    db.composition = compose([HERO], null);
    const undated = await loadCustomPage({}, 'en', PAGE.slug);
    expect(undated?.jsonLd.find((n) => n['@type'] === 'WebPage')).not.toHaveProperty(
      'dateModified',
    );
  });

  // Code review CR6: a section the page does not render (a type outside the custom set, a
  // hidden one) never dates it; the row and what it shows do.
  it('dates its WebPage by the sections it renders, never one it drops', async () => {
    const dateOf = async (sections: SectionData[]) => {
      db.composition = compose(sections);
      const page = await loadCustomPage({}, 'en', PAGE.slug);
      return page?.jsonLd.find((n) => n['@type'] === 'WebPage')?.['dateModified'];
    };
    const later = '2026-10-31T09:00:00+00:00';
    // A form section (outside the custom set, written around the API) edited later.
    expect(await dateOf([HERO, { type: 'contact', props: {}, updatedAt: later }])).toBe(
      PAGE.updatedAt,
    );
    // A hidden block (the unlocked read never carries one, but a preview may).
    expect(await dateOf([HERO, { ...TEXT, visible: false, updatedAt: later }])).toBe(
      PAGE.updatedAt,
    );
    // A shown block in the set does.
    expect(await dateOf([HERO, { ...TEXT, updatedAt: later }])).toBe(later);
  });

  it('wears the overlay header only while it opens on its banner hero (E11-C1)', async () => {
    const header = async (sections: SectionData[]) => {
      db.composition = compose(sections);
      return (await loadCustomPage({}, 'en', PAGE.slug))?.header;
    };
    // An editor moved the hero below a text block: the paper block opens the page.
    expect(await header([TEXT, HERO])).toBe('solid');
    expect(await header([HERO, TEXT])).toBe('overlay');
    // A hidden first section is not what a visitor sees first.
    expect(await header([{ ...TEXT, visible: false }, HERO])).toBe('overlay');
    // No visible heading: the page opens on a banner of its own title.
    expect(await header([TEXT])).toBe('overlay');
    expect(await header([{ ...HERO, visible: false }, TEXT])).toBe('overlay');
  });
});
