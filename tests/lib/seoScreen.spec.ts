import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SEO_DESCRIPTION_MAX, SEO_TITLE_MAX } from '@schemas/admin';
import { IDENTITY_FALLBACK } from '@/lib/identity/fallback';
import { DEFAULT_TITLE_TEMPLATE } from '@/lib/seo/title';
import { seoUi } from '@/lib/admin/ui/seo';
import { PUBLIC_SITE_URL as SITE } from '../stubs/astro-env-client';

// The SEO screen's logic and server HTML (Admin v2 U10): the Google previews, the values the
// panel carries for a full replace, the legacy values it rewrites before a save, the typed
// confirmation's trigger, and the Pages tab's markup (no style attribute: the CSP has no
// 'unsafe-inline'; the row action named for its page; Custom and Default in words).

vi.mock('@/components/admin/RichText', () => ({ default: () => null }));

const { NO_DESCRIPTION, previewOf } = await import('@/components/admin/screens/seo/GooglePreview');
const { default: GooglePreview } = await import('@/components/admin/screens/seo/GooglePreview');
const { legacyFixes, seoPanelFields, SCHEMA_OF_TYPE, HIDE_TEXT, INDEX_LABEL } =
  await import('@/components/admin/screens/seo/SeoPanel');
const { needsConfirmation, CONFIRM_TEXT, CONFIRM_WORD } =
  await import('@/components/admin/screens/seo/SiteWideForm');
const { default: PagesTab, listUrl } = await import('@/components/admin/screens/seo/PagesTab');

const HOST = new URL(SITE).host;
const brand = IDENTITY_FALLBACK.brandName;

describe('the Google previews', () => {
  const base = {
    title: '',
    description: '',
    defaults: { title: 'Logo design | Branding', description: 'Marks that last.' },
    brand: brand.en,
    template: DEFAULT_TITLE_TEMPLATE,
    path: '/services/logo',
  };

  it('an empty box shows the page’s default through the site’s title template', () => {
    expect(previewOf({ ...base, lang: 'en' })).toEqual({
      title: `${brand.en} | Logo design | Branding`,
      url: `${HOST} › services › logo`,
      description: 'Marks that last.',
      empty: false,
    });
  });

  it('what is typed wins; the Arabic result sits under /ar', () => {
    const ar = previewOf({
      ...base,
      lang: 'ar',
      title: 'تصميم الشعار',
      description: 'علامات تدوم',
      brand: brand.ar,
      template: '%s · %brand%',
    });
    expect(ar).toMatchObject({
      title: `تصميم الشعار · ${brand.ar}`,
      url: `${HOST} › ar › services › logo`,
      description: 'علامات تدوم',
    });
    expect(previewOf({ ...base, lang: 'ar', path: '/' }).url).toBe(`${HOST} › ar`);
    expect(previewOf({ ...base, lang: 'en', path: '/' }).url).toBe(HOST);
  });

  it('no description at all: the prototype’s nudge; %brand% filled as the head does', () => {
    const none = previewOf({ ...base, lang: 'en', defaults: { title: 'X', description: '' } });
    expect(none).toMatchObject({ description: NO_DESCRIPTION, empty: true });
    expect(previewOf({ ...base, lang: 'en', description: 'By %brand%.' }).description).toBe(
      `By ${brand.en}.`,
    );
  });

  it('renders plain text, the Arabic card in Arabic and right to left', () => {
    const html = renderToStaticMarkup(
      createElement(GooglePreview, {
        title: { en: '', ar: '' },
        description: { en: '', ar: '' },
        defaults: {
          title: { en: 'About', ar: 'من نحن' },
          description: { en: 'Who we are', ar: '' },
        },
        brand,
        template: { en: DEFAULT_TITLE_TEMPLATE, ar: DEFAULT_TITLE_TEMPLATE },
        path: '/about',
      }),
    );
    expect(html).not.toMatch(/\sstyle=/);
    expect(html).toContain('aria-label="Google preview"');
    expect(html).toContain('aria-label="Google preview in Arabic"');
    expect(html).toContain('lang="ar" dir="rtl"');
    // The Arabic description is missing: the nudge is English, and says so.
    expect(html).toContain(`<span lang="en" dir="ltr">${NO_DESCRIPTION}</span>`);
  });
});

describe('the panel’s fields (a full replace carries every column)', () => {
  const fields = seoPanelFields({
    title: { en: 'Logo', ar: 'شعار' },
    description: { en: 'Marks', ar: '' },
  });

  it('shows title, description and image; carries the image link, robots, canonical, schema', () => {
    expect(fields.map((f) => f.name)).toEqual([
      'metaTitle',
      'metaDescription',
      'ogMediaId',
      'ogImage',
      'robots',
      'canonicalOverride',
      'schemaType',
    ]);
    expect(fields.map((f) => f.column)).toEqual([
      'meta_title',
      'meta_description',
      'og_media_id',
      'og_image',
      'robots',
      'canonical_override',
      'schema_type',
    ]);
  });

  it('caps the boxes as the schema does, and shows the defaults as placeholders', () => {
    expect(fields[0]).toMatchObject({ maxLength: SEO_TITLE_MAX, placeholder: { en: 'Logo' } });
    expect(fields[1]).toMatchObject({ maxLength: SEO_DESCRIPTION_MAX, multiline: true });
    expect(fields[0]?.help).toContain('50 to 60 characters works best');
    expect(fields[1]?.help).toContain('150 to 160 characters works best');
  });

  it('the structured data each kind carries is a type the JSON-LD builders emit', () => {
    const jsonld = readFileSync('src/lib/seo/jsonld.ts', 'utf8');
    for (const type of Object.values(SCHEMA_OF_TYPE)) {
      if (type === 'WebPage') continue; // a page's own types are its sections'
      expect(jsonld).toContain(`'@type': '${type}'`);
    }
  });

  it('no em or en dash in the words it shows (P-12)', () => {
    const words = [
      ...fields.flatMap((f) => [f.label, f.help ?? '']),
      HIDE_TEXT,
      INDEX_LABEL,
      CONFIRM_TEXT,
      ...seoUi.fields.flatMap((f) => [f.label, f.help ?? '']),
    ];
    for (const word of words) expect(word).not.toMatch(/[–—]/);
  });
});

describe('values written before the rules', () => {
  it('a free-text robots value and an absolute canonical on this site become what a save takes', () => {
    expect(
      legacyFixes({ robots: 'NOINDEX, NOFOLLOW', canonicalOverride: `${SITE}/ar/services/x` }),
    ).toEqual({ robots: 'noindex,follow', canonicalOverride: '/services/x' });
    expect(legacyFixes({ robots: 'index, follow' })).toEqual({ robots: 'index,follow' });
  });

  it('another origin is dropped, and closed values are left alone', () => {
    expect(legacyFixes({ canonicalOverride: 'https://evil.example/x' })).toEqual({
      canonicalOverride: '',
    });
    expect(
      legacyFixes({ robots: 'noindex,follow', canonicalOverride: '/services/x', ogImage: 'x' }),
    ).toBeNull();
    expect(legacyFixes({ robots: '', canonicalOverride: '' })).toBeNull();
  });
});

describe('the typed confirmation (a site-wide noindex)', () => {
  it('asks only when a save moves the site from indexed to hidden', () => {
    expect(CONFIRM_WORD).toBe('noindex');
    expect(needsConfirmation('index,follow', 'noindex,follow')).toBe(true);
    expect(needsConfirmation('index,follow', 'noindex,nofollow')).toBe(true);
    expect(needsConfirmation(undefined, 'noindex,follow')).toBe(true);
    expect(needsConfirmation('noindex,follow', 'noindex,nofollow')).toBe(false);
    expect(needsConfirmation('noindex,follow', 'index,follow')).toBe(false);
    expect(needsConfirmation('index,follow', 'index,follow')).toBe(false);
  });
});

describe('the Pages tab', () => {
  const row = (n: number, over: Record<string, unknown> = {}) => ({
    id: `service:${n}`,
    entityType: 'service' as const,
    entityId: `33333333-3333-4333-8333-00000000000${n}`,
    label: `Service ${n}`,
    slug: `service-${n}`,
    status: 'published',
    path: `/services/service-${n}`,
    version: 0,
    robots: null,
    indexed: true,
    canonicalOverride: null,
    ogMediaId: null,
    ogImage: null,
    title: { custom: null, default: { en: `Service ${n} | Branding`, ar: 'خدمة' } },
    description: { custom: null, default: { en: 'A tagline', ar: 'سطر' } },
    arabicComplete: true,
    ...over,
  });
  const initial = {
    type: 'service' as const,
    total: 2,
    offset: 0,
    limit: 50,
    brand,
    titleTemplate: { en: DEFAULT_TITLE_TEMPLATE, ar: DEFAULT_TITLE_TEMPLATE },
    defaultRobots: 'index,follow',
    rows: [
      row(1),
      row(2, {
        status: 'draft',
        indexed: false,
        robots: 'noindex,follow',
        arabicComplete: false,
        title: { custom: { en: 'Own title', ar: 'عنوان' }, default: { en: 'X', ar: 'س' } },
      }),
    ],
  };

  it('renders the first page from the server’s answer, with no style attribute', () => {
    const html = renderToStaticMarkup(createElement(PagesTab, { initial, canAdvanced: true }));
    expect(html).not.toMatch(/\sstyle=/);
    expect(html).toContain('aria-label="Edit SEO for Service 1"');
    expect(html).toContain('aria-label="Edit SEO for Service 2"');
    for (const word of ['Custom', 'Default', 'Indexed', 'Hidden', 'Complete', 'Arabic missing']) {
      expect(html).toContain(`>${word}<`);
    }
    expect(html).toContain('/services/service-1');
    // The chips, Services pressed.
    expect(html).toMatch(/aria-pressed="true"[^>]*>Services</);
    // No drawer until a row is opened.
    expect(html).not.toContain('<dialog');
  });

  it('asks the list for a type, a page and a bounded search', () => {
    expect(listUrl('portfolio', 50, '  rider ')).toBe(
      '/api/admin/entity-seo/list?type=portfolio&offset=50&limit=50&q=rider',
    );
    expect(listUrl('page', 0, '')).toBe('/api/admin/entity-seo/list?type=page&offset=0&limit=50');
    expect(new URL(listUrl('page', 0, 'x'.repeat(80)), SITE).searchParams.get('q')).toHaveLength(
      64,
    );
  });
});
