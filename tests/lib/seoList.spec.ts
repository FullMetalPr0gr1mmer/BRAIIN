import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Locale } from '@schemas/primitives';
import { IDENTITY_FALLBACK } from '@/lib/identity/fallback';
import { pickLocale, pickLocaleStrict } from '@/lib/i18n';
import { caseDescription, caseTitle } from '@/lib/portfolio/casePage';
import { serviceDescription, serviceTitle } from '@/lib/services/page';
import { PAGE_META } from '@/lib/seo/pageMeta';
import { applyTitleTemplate, DEFAULT_TITLE_TEMPLATE } from '@/lib/seo/title';
import { defaultsFor, pageFallback, type TargetRow } from '@/lib/admin/seo/defaults';
import {
  ilikeValue,
  listEntitySeo,
  SEO_LIST_MAX,
  SEO_LIST_Q_MAX,
  SeoListQuerySchema,
} from '@/lib/admin/seo/list';
import type { SeoEntityType } from '@/lib/seo/entityPaths';
import { client, T, type Db, type Row } from '../fixtures/stagedDb';

// The SEO screen's Pages list (Admin v2 U10, AV-19). Its "Default" column must say what the
// public head would show, so it is computed by the routes' own fallbacks: these hold the
// parity per type and language (the page's own words, then the tenant default, through the
// title template, exactly as loadHead resolves them), the Custom/Default and Arabic flags,
// and the query's bounds.

let tenantDefaults: Row | null = null;

vi.mock('@/lib/data/siteProfile', () => ({ getSiteProfile: async () => IDENTITY_FALLBACK }));
vi.mock('@/lib/data/seo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/data/seo')>()),
  getEntitySeo: async () => null,
  getSeoDefaults: async () => tenantDefaults,
}));

const { loadHead } = await import('@/lib/seo/head');

const BI = (en: string, ar: string) => ({ en, ar });

const TARGETS: Record<SeoEntityType, TargetRow> = {
  page: { id: 'p1', slug: 'about', title: BI('About', 'من نحن'), status: 'published' },
  service: {
    id: 's1',
    slug: 'logo',
    title: BI('Logo design', 'تصميم الشعار'),
    status: 'published',
    blurb: BI('Marks that last', 'علامات تدوم'),
    discipline: { name: BI('Branding', 'الهوية') },
  },
  portfolio: {
    id: 'w1',
    slug: 'the-rider',
    title: BI('The Rider', 'الراكب'),
    status: 'published',
    project_type: BI('Film', 'فيلم'),
    teaser: null,
    summary: BI('A short film', ''),
  },
  blog_post: {
    id: 'b1',
    slug: 'hello',
    title: BI('Hello', 'مرحبا'),
    status: 'draft',
    excerpt: BI('A first post', ''),
  },
};

/** What each route hands loadHead as its fallbacks, from the public data's own shapes. */
function routeFallback(type: SeoEntityType, row: TargetRow, locale: Locale) {
  switch (type) {
    case 'page':
      return PAGE_META.about[locale];
    case 'service': {
      // toServiceDetail: tagline = blurb, discipline = the embed.
      const service = {
        title: row.title,
        tagline: row.blurb ?? null,
        discipline: row.discipline ? { slug: 'branding', name: row.discipline.name } : null,
      };
      return {
        title: serviceTitle(service as Parameters<typeof serviceTitle>[0], locale),
        description: serviceDescription(
          service as Parameters<typeof serviceDescription>[0],
          locale,
        ),
      };
    }
    case 'portfolio': {
      // toCard: blurb = teaser ?? summary.
      const study = {
        title: row.title,
        projectType: row.project_type ?? null,
        blurb: row.teaser ?? row.summary ?? null,
        summary: row.summary ?? null,
      };
      return {
        title: caseTitle(study as Parameters<typeof caseTitle>[0], locale),
        description: caseDescription(study as Parameters<typeof caseDescription>[0], locale),
      };
    }
    case 'blog_post':
      // BlogDetail.astro.
      return {
        title: pickLocale(row.title, locale, row.slug),
        description: pickLocaleStrict(row.excerpt, locale),
      };
  }
}

beforeEach(() => {
  tenantDefaults = null;
});

describe('the defaults are what the public head shows (parity with loadHead)', () => {
  const TYPES = Object.keys(TARGETS) as SeoEntityType[];

  it.each(TYPES.flatMap((type) => (['en', 'ar'] as const).map((locale) => [type, locale])))(
    '%s in %s: the page’s own words, by the route’s own functions',
    (type, locale) => {
      const row = TARGETS[type as SeoEntityType];
      expect(pageFallback(type as SeoEntityType, row, locale as Locale)).toEqual(
        routeFallback(type as SeoEntityType, row, locale as Locale),
      );
    },
  );

  it.each(TYPES.flatMap((type) => (['en', 'ar'] as const).map((locale) => [type, locale])))(
    '%s in %s: the list’s default, through the template, equals loadHead’s title and description',
    async (type, locale) => {
      tenantDefaults = {
        title_template: { en: '%s · %brand%', ar: '%brand% | %s' },
        default_title: { en: 'Studio', ar: 'الاستوديو' },
        default_description: { en: 'We make things.', ar: 'نصنع الأشياء.' },
        default_og_image: null,
        robots_directives: 'index,follow',
      };
      const row = TARGETS[type as SeoEntityType];
      const lang = locale as Locale;
      const own = routeFallback(type as SeoEntityType, row, lang);
      const { seo, brand } = await loadHead(
        {},
        {
          locale: lang,
          fallbackTitle: own.title,
          fallbackDescription: own.description,
          entity: { type: type as SeoEntityType, id: row.id },
        },
      );
      const listed = defaultsFor(type as SeoEntityType, row, tenantDefaults as never);
      const template = (tenantDefaults['title_template'] as Record<Locale, string>)[lang];
      expect(applyTitleTemplate(template, listed.title[lang], brand)).toBe(seo.title);
      expect(listed.description[lang].replace(/%brand%/g, () => brand)).toBe(seo.description);
    },
  );

  it('a page with no words of its own falls to the tenant default, as resolveSeo does', async () => {
    tenantDefaults = {
      title_template: {},
      default_title: { en: 'Studio', ar: 'الاستوديو' },
      default_description: { en: 'We make things.', ar: 'نصنع الأشياء.' },
      default_og_image: null,
      robots_directives: 'index,follow',
    };
    const bare: TargetRow = { id: 'p9', slug: 'unknown-page', title: BI('', ''), status: 'draft' };
    const listed = defaultsFor('page', bare, tenantDefaults as never);
    expect(listed.title).toEqual({ en: 'Studio', ar: 'الاستوديو' });
    expect(listed.description).toEqual({ en: 'We make things.', ar: 'نصنع الأشياء.' });
    const { seo, brand } = await loadHead(
      {},
      { locale: 'ar', fallbackTitle: '', entity: { type: 'page', id: 'p9' } },
    );
    expect(applyTitleTemplate(DEFAULT_TITLE_TEMPLATE, listed.title.ar, brand)).toBe(seo.title);
    expect(listed.description.ar).toBe(seo.description);
  });
});

// ── The list over the PostgREST stand-in ─────────────────────────────────────────────────

const SERVICE = (n: number, over: Row = {}): Row => ({
  id: `33333333-3333-4333-8333-00000000000${n}`,
  tenant_id: T,
  slug: `service-${n}`,
  title: BI(`Service ${n}`, `خدمة ${n}`),
  status: 'published',
  blurb: BI('A tagline', ''),
  discipline: null,
  sort_order: n,
  ...over,
});

function dbWith(tables: Record<string, Row[]>): Db {
  return { tables, flag: false, calls: [], user: 'u', now: () => new Date().toISOString() };
}

const auth = { tenantId: T } as Parameters<typeof listEntitySeo>[1];

describe('listEntitySeo', () => {
  it('pages services in order, archived left out, with Custom and Default per field', async () => {
    const db = dbWith({
      services: [
        SERVICE(1),
        SERVICE(2),
        SERVICE(3, { status: 'archived' }),
        SERVICE(4, { status: 'draft' }),
      ],
      entity_seo: [
        {
          id: 'e1',
          tenant_id: T,
          entity_type: 'service',
          entity_id: SERVICE(2)['id'],
          meta_title: BI('Custom title', 'عنوان مخصص'),
          meta_description: {},
          og_image: null,
          og_media_id: null,
          canonical_override: null,
          robots: 'NOINDEX',
          schema_type: null,
          version: 4,
        },
      ],
      seo_defaults: [],
      site_profile: [],
    });
    const page = await listEntitySeo(
      client(db) as never,
      auth,
      SeoListQuerySchema.parse({ type: 'service', limit: '2' }),
    );
    expect(page.total).toBe(3);
    expect(page.rows.map((r) => r.slug)).toEqual(['service-1', 'service-2']);
    const [plain, custom] = page.rows;
    expect(plain).toMatchObject({
      version: 0,
      robots: null,
      indexed: true,
      title: { custom: null },
      description: { custom: null },
      path: '/services/service-1',
    });
    // A tagline with no Arabic falls to the generic line in Arabic (serviceDescription).
    expect(plain!.arabicComplete).toBe(true);
    expect(custom).toMatchObject({
      version: 4,
      // A legacy free-text noindex is shown as the closed value, and hides the page.
      robots: 'noindex,follow',
      indexed: false,
      title: { custom: BI('Custom title', 'عنوان مخصص') },
      description: { custom: null },
    });
    expect(page.brand).toEqual(IDENTITY_FALLBACK.brandName);
    expect(page.titleTemplate).toEqual({ en: DEFAULT_TITLE_TEMPLATE, ar: DEFAULT_TITLE_TEMPLATE });
    expect(page.defaultRobots).toBe('index,follow');
  });

  it('Arabic is incomplete when the head would show no Arabic title or description', async () => {
    const db = dbWith({
      pages: [
        { id: 'p1', tenant_id: T, slug: 'unknown', title: BI('Odd page', ''), status: 'draft' },
      ],
      entity_seo: [],
      seo_defaults: [],
      site_profile: [],
    });
    const page = await listEntitySeo(client(db) as never, auth, SeoListQuerySchema.parse({}));
    expect(page.type).toBe('page');
    expect(page.rows[0]).toMatchObject({ path: null, arabicComplete: false, status: 'draft' });
  });

  it('a noindex site default hides every page without its own value', async () => {
    const db = dbWith({
      services: [SERVICE(1)],
      entity_seo: [],
      seo_defaults: [{ tenant_id: T, robots_directives: 'noindex,nofollow' }],
      site_profile: [],
    });
    const page = await listEntitySeo(
      client(db) as never,
      auth,
      SeoListQuerySchema.parse({ type: 'service' }),
    );
    expect(page.defaultRobots).toBe('noindex,nofollow');
    expect(page.rows[0]).toMatchObject({ robots: null, indexed: false });
  });
});

describe('the query and its bounds', () => {
  it('defaults to the first 50 pages', () => {
    expect(SeoListQuerySchema.parse({})).toEqual({ type: 'page', offset: 0, limit: 50 });
  });

  it.each([
    [{ limit: String(SEO_LIST_MAX + 1) }],
    [{ limit: '0' }],
    [{ offset: '-1' }],
    [{ type: 'redirect' }],
    [{ q: 'x'.repeat(SEO_LIST_Q_MAX + 1) }],
    [{ q: 'a\u0000b' }],
    [{ q: 'line\nbreak' }],
  ])('refuses %j (a 422 from the kernel, never a logged error)', (query) => {
    expect(SeoListQuerySchema.safeParse(query).success).toBe(false);
  });

  it('a search term is escaped for LIKE and quoted for the or filter', () => {
    expect(ilikeValue('logo')).toBe('"%logo%"');
    expect(ilikeValue('50%_off')).toBe('"%50\\\\%\\\\_off%"');
    expect(ilikeValue('a,b)')).toBe('"%a,b)%"');
    expect(ilikeValue('say "hi"')).toBe('"%say \\"hi\\"%"');
  });
});
