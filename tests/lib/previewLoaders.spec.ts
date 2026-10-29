import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { createPreviewSource } from '@/lib/preview/dataset';
import { isPreviewTable, resolveEmbed } from '@/lib/preview/relations';
import { parseSelect, type SelectItem } from '@/lib/preview/select';
import { MIRRORED_POLICIES } from '@/lib/preview/visibility';
import { scanTree } from './sourceScan';
import { loaderQueries } from './loaderQueries';
import { BI, draft, fakeStaffClient, fixtureTables, ID, session } from '../fixtures/previewDataset';

// Loader conformance, the unit-level parity (Admin v2 R8): every exported loader of the 15
// files runs inside the preview's scope over the fixture tenant and returns what a visitor
// would get of it (hand-written below), with no refusal and every read going through the
// overlay. And a static check that every table and embed target any loader reads is in the
// preview's relations and mirror, so a slice adding a public read cannot skip them. R9's
// parity e2e is the end-to-end proof, page by page.

// Supabase is "configured" for the loaders, and the anon client must never be reached
// inside the scope: if a loader found it, this throws (and the report counts it).
vi.mock('@/lib/supabase/client', () => ({
  supabaseConfigured: () => true,
  anonClient: () => {
    throw new Error('the anon client was reached inside a preview');
  },
}));
// The fixture's static stills resolve (`fixture-NNN` keys); anything else does not.
vi.mock('@/lib/media/static', () => ({
  staticImage: (key: string) =>
    key.startsWith('fixture-')
      ? { src: `/_astro/${key}.webp`, width: 800, height: 600, format: 'webp' }
      : null,
}));

const { withContentSource } = await import('@/lib/data/source');
const appearance = await import('@/lib/data/appearance');
const blog = await import('@/lib/data/blog');
const certifications = await import('@/lib/data/certifications');
const disciplines = await import('@/lib/data/disciplines');
const faq = await import('@/lib/data/faq');
const ga4 = await import('@/lib/data/ga4');
const navigation = await import('@/lib/data/navigation');
const pageSections = await import('@/lib/data/pageSections');
const portfolio = await import('@/lib/data/portfolio');
const search = await import('@/lib/data/search');
const sectionMedia = await import('@/lib/data/sectionMedia');
const seo = await import('@/lib/data/seo');
const serviceCases = await import('@/lib/data/serviceCases');
const services = await import('@/lib/data/services');
const siteProfile = await import('@/lib/data/siteProfile');
const siteVerification = await import('@/lib/data/siteVerification');
const statistics = await import('@/lib/data/statistics');
const taxonomy = await import('@/lib/data/taxonomy');
const team = await import('@/lib/data/team');

const MODULES = {
  appearance,
  blog,
  certifications,
  disciplines,
  faq,
  ga4,
  navigation,
  pageSections,
  portfolio,
  search,
  sectionMedia,
  seo,
  serviceCases,
  services,
  siteProfile,
  siteVerification,
  statistics,
  taxonomy,
  team,
};

/** Exported functions that query nothing (row → model mappers, the SEO resolver). */
const PURE = new Set([
  'toCard',
  'toCaseStudy',
  'renderBody',
  'parseCaseStudies',
  'toDiscipline',
  'toServiceSummary',
  'toServiceDetail',
  'toServiceCase',
  'toLeader',
  'resolveSeo',
]);

/** Runs `fn` as a preview over the fixture tenant (with `drafts`), returning its report. */
async function inPreview<T>(fn: () => Promise<T>, drafts: Record<string, unknown>[] = []) {
  const source = createPreviewSource({
    supabase: fakeStaffClient({ ...fixtureTables(), content_drafts: drafts }).client,
    session: session('admin'),
  });
  const value = await withContentSource(source, fn);
  return { value, report: source.report() };
}

/** Each loader, run in preview, with what a visitor reads of the fixture. */
const CASES: Record<string, () => Promise<void>> = {
  'blog.getPublishedPosts': async () => {
    const { value, report } = await inPreview(() => blog.getPublishedPosts());
    expect(value.map((p) => [p.slug, p.author?.slug ?? null, p.category?.slug ?? null])).toEqual([
      ['new', 'nora', 'craft'],
      ['old', null, 'craft'],
      ['undated', 'nora', null],
    ]);
    clean(report);
  },
  'blog.getPostBySlug': async () => {
    const { value, report } = await inPreview(() => blog.getPostBySlug('new'));
    expect(value?.slug).toBe('new');
    expect((await inPreview(() => blog.getPostBySlug('draft-post'))).value).toBeNull();
    clean(report);
  },
  'certifications.getPublishedCertifications': async () => {
    const { value, report } = await inPreview(() => certifications.getPublishedCertifications());
    expect(value.map((c) => c.slug)).toEqual(['iso']);
    clean(report);
  },
  'disciplines.getPublishedDisciplines': async () => {
    const { value, report } = await inPreview(() => disciplines.getPublishedDisciplines());
    expect(value.map((d) => [d.slug, d.poster?.id ?? null, d.services.map((s) => s.slug)])).toEqual(
      [['branding', ID.mDiscPoster, ['logo']]],
    );
    clean(report);
  },
  'appearance.getHeaderSettings': async () => {
    // Admin v2 E5: anon's columns of the row; the fixture sets a small logo.
    const { value, report } = await inPreview(() => appearance.getHeaderSettings());
    expect(value.logoSize).toBe('s');
    expect(value.ctaShow).toBe(false);
    clean(report);
  },
  'faq.getFaq': async () => {
    // Published only, in order, in the reader's language (Admin v2 U7).
    const { value, report } = await inPreview(() => faq.getFaq('ar'));
    expect(value).toEqual([{ question: 'لمن الشغل؟', answer: 'لك.' }]);
    clean(report);
  },
  'navigation.getNavigation': async () => {
    const { value, report } = await inPreview(() => navigation.getNavigation('header'));
    expect(value.map((n) => [n.href, n.children.map((c) => c.href)])).toEqual([
      ['/portfolio', ['/portfolio/all']],
    ]);
    clean(report);
  },
  'pageSections.getPageComposition': async () => {
    const { value, report } = await inPreview(() => pageSections.getPageComposition('home'));
    expect(value?.page.id).toBe(ID.pgHome);
    expect(value?.sections.map((s) => s.type)).toEqual(['cta']);
    expect((await inPreview(() => pageSections.getPageComposition('about'))).value).toBeNull();
    // Behind a password (0061): the page, and none of its sections, as a visitor reads it.
    const locked = await inPreview(() => pageSections.getPageComposition('join'));
    expect(locked.value).toEqual(expect.objectContaining({ sections: [] }));
    expect(locked.value?.page.id).toBe(ID.pgLocked);
    clean(report);
  },
  'pageSections.getPageSections': async () => {
    const { value, report } = await inPreview(() => pageSections.getPageSections('home'));
    expect(value?.map((s) => s.type)).toEqual(['cta']);
    clean(report);
  },
  'portfolio.getPortfolioCards': async () => {
    const { value, report } = await inPreview(() => portfolio.getPortfolioCards());
    expect(
      value.map((c) => [
        c.slug,
        c.poster?.id ?? null,
        c.client?.slug ?? null,
        c.confidentialClient,
        c.sector?.slug ?? null,
        c.services.map((s) => s.slug),
      ]),
    ).toEqual([
      // the external poster resolves to nothing; its client is visible
      ['film', null, 'acme', false, null, []],
      // a hidden client is confidential; the draft service's link embeds null and is dropped
      ['launch', ID.mPoster, null, true, 'retail', ['logo']],
    ]);
    const featured = await inPreview(() => portfolio.getPortfolioCards({ featuredOnly: true }));
    expect(featured.value.map((c) => c.slug)).toEqual(['film']);
    clean(report);
  },
  'portfolio.getCaseStudyIndex': async () => {
    const { value, report } = await inPreview(() => portfolio.getCaseStudyIndex());
    expect(value.map((e) => e.slug)).toEqual(['film', 'launch']);
    clean(report);
  },
  'portfolio.getCaseStudy': async () => {
    const { value, report } = await inPreview(() => portfolio.getCaseStudy('launch'));
    expect(value?.gallery.map((m) => m.image?.id ?? null)).toEqual([ID.mFrame]);
    expect((await inPreview(() => portfolio.getCaseStudy('secret-project'))).value).toBeNull();
    clean(report);
  },
  'search.searchContent': async () => {
    const { value, report } = await inPreview(() => search.searchContent('logo', 'en'));
    expect(value).toEqual([]);
    expect(report.notPreviewed).toEqual(['rpc:search_content']);
    expect(report.unsupported).toEqual([]);
    expect(report.anonLookups).toBe(0);
  },
  'search.searchSuggest': async () => {
    const { value, report } = await inPreview(() => search.searchSuggest('logo', 'en'));
    expect(value).toEqual([]);
    expect(report.notPreviewed).toEqual(['rpc:search_suggest']);
    expect(report.unsupported).toEqual([]);
  },
  'sectionMedia.getSectionImages': async () => {
    const { value, report } = await inPreview(() =>
      sectionMedia.getSectionImages([ID.mSection, ID.mHiddenSection, ID.mUnref, ID.mLockedSection]),
    );
    expect([...value.keys()]).toEqual([ID.mSection]);
    clean(report);
  },
  'sectionMedia.getSectionImage': async () => {
    const { value, report } = await inPreview(() => sectionMedia.getSectionImage(ID.mSection));
    expect(value?.id).toBe(ID.mSection);
    clean(report);
  },
  'seo.getEntitySeo': async () => {
    const { value, report } = await inPreview(() => seo.getEntitySeo('service', ID.sPub));
    expect(value?.meta_title).toEqual(BI(`Title ${ID.esSvc.slice(-3)}`, 'عنوان'));
    expect((await inPreview(() => seo.getEntitySeo('service', ID.sDraft))).value).toBeNull();
    clean(report);
  },
  'seo.getSeoRules': async () => {
    // Admin v2 U10 (D8): the fixture's SEO rows set neither robots nor a canonical, so none
    // is a rule; the published pages are read by slug.
    const { value, report } = await inPreview(() => seo.getSeoRules());
    expect(value?.rules).toEqual([]);
    expect(value?.pages.map((p) => p.slug)).toContain('home');
    clean(report);
  },
  'seo.getSeoDefaults': async () => {
    const { value, report } = await inPreview(() => seo.getSeoDefaults());
    expect(value?.robots_directives).toBe('index,follow');
    clean(report);
  },
  'serviceCases.getServiceCase': async () => {
    const { value, report } = await inPreview(() => serviceCases.getServiceCase(ID.sPub));
    expect(value?.project).toMatchObject({
      slug: 'launch',
      client: null,
      confidentialClient: true,
    });
    expect((await inPreview(() => serviceCases.getServiceCase(ID.sHiddenByDisc))).value).toBeNull();
    clean(report);
  },
  'services.loadPublishedServiceRows': async () => {
    const { value, report } = await inPreview(() => services.loadPublishedServiceRows());
    expect(value?.map((s) => s.slug)).toEqual(['logo', 'hosting']);
    clean(report);
  },
  'services.getPublishedServices': async () => {
    const { value, report } = await inPreview(() => services.getPublishedServices());
    expect(value.map((s) => [s.slug, s.poster?.id ?? null])).toEqual([
      ['logo', ID.mSvcPoster],
      ['hosting', null],
    ]);
    clean(report);
  },
  'services.getServiceBySlug': async () => {
    const { value, report } = await inPreview(() => services.getServiceBySlug('logo'));
    expect(value?.discipline?.slug).toBe('branding');
    expect((await inPreview(() => services.getServiceBySlug('venue'))).value).toBeNull();
    clean(report);
  },
  'siteProfile.getSiteProfile': async () => {
    const { value, report } = await inPreview(() => siteProfile.getSiteProfile());
    expect(value.contactEmail).toBe('hello@example.test');
    expect(value.footer).toEqual({
      copyright: null,
      style: 'light',
      showEmail: true,
      showSocial: false,
    });
    clean(report);
  },
  // Admin v2 U9: the icons are one media read for the ids the identity names. The fixture's
  // identity names a project poster (a static still, not an upload) as its favicon, and a
  // missing id as its app icon: an icon must be an uploaded square, so neither is one, and
  // the read goes through the overlay like every other.
  'siteProfile.readSiteIcons': async () => {
    const { value, report } = await inPreview(async () =>
      siteProfile.readSiteIcons({
        ...(await siteProfile.getSiteProfile()),
        faviconMediaId: ID.mPoster,
        appIconMediaId: '00000000-0000-4000-8000-00000000dead',
      }),
    );
    expect(value).toEqual({ favicon: null, appIcon: null });
    clean(report);
  },
  'siteVerification.getSearchConsoleToken': async () => {
    // Admin v2 U11: anon's Search Console column of the row.
    const { value, report } = await inPreview(() => siteVerification.getSearchConsoleToken());
    expect(value).toBe('FixtureCode_0123456789');
    clean(report);
  },
  'ga4.getGa4MeasurementId': async () => {
    // Admin v2 U15: anon's GA4 column of the row (U15's migration). A preview never loads GA4 (the
    // middleware's preview branch returns before the read), but the loader reads through the
    // overlay like every other.
    const { value, report } = await inPreview(() => ga4.getGa4MeasurementId());
    expect(value).toBe('G-FIXTURE1');
    clean(report);
  },
  'statistics.getPublishedStatistics': async () => {
    const { value, report } = await inPreview(() =>
      statistics.getPublishedStatistics({ placement: 'about' }),
    );
    expect(value.map((s) => s.slug)).toEqual(['projects']);
    clean(report);
  },
  'taxonomy.getSectors': async () => {
    const { value, report } = await inPreview(() => taxonomy.getSectors());
    expect(value.map((s) => s.slug)).toEqual(['retail']);
    clean(report);
  },
  'taxonomy.getMarqueeClients': async () => {
    const { value, report } = await inPreview(() => taxonomy.getMarqueeClients());
    expect(value.map((c) => [c.slug, c.logo?.id ?? null])).toEqual([['acme', ID.mLogo]]);
    clean(report);
  },
  'taxonomy.getTestimonials': async () => {
    const { value, report } = await inPreview(() =>
      taxonomy.getTestimonials({ placement: 'home' }),
    );
    expect(value.map((t) => [t.slug, t.avatar?.id ?? null])).toEqual([['quote-a', ID.mAvatar]]);
    const byProject = await inPreview(() =>
      taxonomy.getTestimonials({ portfolioId: ID.pPub, limit: 1 }),
    );
    expect(byProject.value.map((t) => t.slug)).toEqual(['quote-a']);
    clean(report);
  },
  'team.getPublishedTeam': async () => {
    const { value, report } = await inPreview(() => team.getPublishedTeam());
    expect(value.map((m) => m.slug)).toEqual(['nora']);
    clean(report);
  },
  'team.getLeadership': async () => {
    const { value, report } = await inPreview(() => team.getLeadership());
    expect(value.map((m) => [m.slug, m.portrait?.id ?? null])).toEqual([['nora', ID.mPortrait]]);
    clean(report);
  },
};

/** A render that went through the overlay, refused nothing and never reached the anon client. */
function clean(report: ReturnType<ReturnType<typeof createPreviewSource>['report']>) {
  expect(report.reads).toBeGreaterThan(0);
  expect(report.unsupported).toEqual([]);
  expect(report.anonLookups).toBe(0);
  expect(report.failedTables).toEqual([]);
  expect(report.truncated).toEqual([]);
}

describe('every public loader, inside the preview scope', () => {
  it('has a case for every exported loader function of the 19 files', () => {
    const exported = Object.entries(MODULES).flatMap(([name, mod]) =>
      Object.entries(mod)
        .filter(([key, value]) => typeof value === 'function' && !PURE.has(key))
        .map(([key]) => `${name}.${key}`),
    );
    expect(Object.keys(CASES).sort()).toEqual(exported.sort());
  });

  for (const [name, run] of Object.entries(CASES)) it(name, run);

  it('shows a pending change through the loader that reads it', async () => {
    const { value, report } = await inPreview(
      () => services.getPublishedServices(),
      [
        draft('service', 'update', ID.sDraft, {
          status: 'published',
          title: BI('Boxes', 'صناديق'),
        }),
        draft('discipline', 'update', ID.dDraft, { status: 'published' }),
      ],
    );
    expect(value.map((s) => s.slug)).toEqual(['logo', 'hosting', 'venue', 'packaging']);
    expect(report.overlaid).toBe(2);
    clean(report);
  });
});

describe('the loaders read nothing the preview does not know', () => {
  const queries = loaderQueries();

  it('every table a loader reads is a preview table with a mirrored rule', () => {
    for (const q of queries.filter((q) => q.table !== null)) {
      expect(isPreviewTable(q.table!), `${q.file}:${q.line} ${q.table}`).toBe(true);
      expect(MIRRORED_POLICIES[q.table as keyof typeof MIRRORED_POLICIES], q.table!).toBeDefined();
    }
  });

  it('every embed target resolves in relations.ts, to a table with a mirrored rule', () => {
    const walk = (table: string, items: readonly SelectItem[], where: string) => {
      for (const item of items) {
        if (item.kind !== 'embed') continue;
        const relation = resolveEmbed(table, item.target);
        expect(relation, `${where}: ${table} → ${item.target}`).not.toBeNull();
        expect(MIRRORED_POLICIES[relation!.target]).toBeDefined();
        walk(relation!.target, item.items, where);
      }
    };
    for (const q of queries.filter((q) => q.table !== null)) {
      walk(q.table!, parseSelect(q.select!), `${q.file}:${q.line}`);
    }
  });

  it('the only rpcs are the two search functions, which the preview answers "not previewed"', () => {
    expect(
      queries
        .filter((q) => q.rpc !== null)
        .map((q) => q.rpc)
        .sort(),
    ).toEqual(['search_content', 'search_suggest']);
  });

  it('reads the loaders the seam guard pins (tests/lib/contentSource.spec.ts)', () => {
    const files = new Set(queries.map((q) => q.file));
    const loaders = scanTree(join(process.cwd(), 'src/lib/data'))
      .filter((f) => f.names.has('contentClient') && !f.path.endsWith('/source.ts'))
      .map((f) => f.path);
    expect([...files].sort()).toEqual(loaders.sort());
    expect(files.size).toBe(Object.keys(MODULES).length);
  });
});
