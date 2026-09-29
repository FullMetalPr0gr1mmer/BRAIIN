import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServiceDetailRow } from '@schemas/content';
import type { Discipline } from '@/lib/data/disciplines';
import type { ServiceCase } from '@/lib/data/serviceCases';
import type { ImageRef } from '@/lib/media/resolve';
import {
  SEED_DISCIPLINES,
  SEED_SERVICES,
  seedDisciplines,
  seedServiceDetailRow,
  serviceId,
} from '../fixtures/serviceSeeds';

// The service page (Round 2 — /services/[slug], S4): the retired-slug map, the page loader
// and the route's three answers (page / 301 / 404), the title and description rules, the
// page copy's accent ranges, and the floating button's pure decisions. The data modules
// are stubbed with the SEEDED catalogue (tests/fixtures/serviceSeeds.ts), so "Logo Design
// sits in Branding with 7 siblings" is the real data's claim, not this file's.

vi.mock('@/lib/media/static', () => ({
  staticImage: (key: string) =>
    key.startsWith('stills/') ? { src: `/_astro/${key}`, width: 1600, height: 900 } : null,
}));

let rows: Record<string, ServiceDetailRow> = {};
let disciplines: Discipline[] = [];
let cases: Record<string, ServiceCase> = {};
const calls: string[] = [];

vi.mock('@/lib/data/services', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/data/services')>()),
  getServiceBySlug: async (slug: string) => {
    calls.push(`service:${slug}`);
    return rows[slug] ?? null;
  },
}));
vi.mock('@/lib/data/disciplines', () => ({
  getPublishedDisciplines: async () => {
    calls.push('disciplines');
    return disciplines;
  },
}));
vi.mock('@/lib/data/serviceCases', () => ({
  getServiceCase: async (id: string) => {
    calls.push(`case:${id}`);
    return cases[id] ?? null;
  },
}));
const heads: { title: string; description: string | undefined; entity: unknown }[] = [];
vi.mock('@/lib/seo/head', () => ({
  loadHead: async (
    _locals: unknown,
    opts: {
      fallbackTitle: string | Promise<string>;
      fallbackDescription?: string | Promise<string>;
      entity: unknown;
    },
  ) => {
    calls.push('head');
    const [title, description, entity] = await Promise.all([
      opts.fallbackTitle,
      opts.fallbackDescription,
      opts.entity,
    ]);
    heads.push({ title, description, entity });
    return { seo: { title }, identity: {}, brand: 'B' };
  },
}));

const {
  loadServicePage,
  resolveServiceRoute,
  serviceTitle,
  serviceDescription,
  serviceHeroSub,
  disciplineOf,
} = await import('@/lib/services/page');
const { caseFigure, CASE_IMAGE_SLOT } = await import('@/lib/services/caseFigure');
const { serviceCacheEntities } = await import('@/lib/services/page');
const {
  RETIRED_SERVICES,
  RETIRED_CACHE_CONTROL,
  RENAMED_SERVICE_SLUGS,
  retiredTarget,
  retiredRedirect,
  renamedServiceSlug,
  canonicalServiceSlug,
} = await import('@/lib/services/retired');
const { SERVICE_PAGE_COPY, VALUE_ACCENT, moreHeading, moreTag } =
  await import('@/lib/services/pageCopy');
const { SERVICE_PAGE_META } = await import('@/lib/seo/pageMeta');
const { splitAccent, accentRange } = await import('@/lib/text/accent');
const fab = await import('@/lib/client/serviceFab');
const { hashTarget } = await import('@/lib/client/landOnHash');

const t = (en: string) => ({ en, ar: `ع-${en}` });
const logoCase = (): ServiceCase => ({
  id: 'ca5e0000-0000-4000-8000-000000000001',
  serviceId: serviceId('logo'),
  title: t('A school group rebrand'),
  context: t('Client C had grown to four campuses.'),
  problems: [{ problem: t('Four logos'), solution: t('One master mark') }],
  results: [{ value: '+27%', label: t('parent recall') }],
  updatedAt: null,
  project: {
    slug: 'notebook',
    title: t('Notebook'),
    poster: null,
    sector: { slug: 'education', name: t('Education'), order: 30 },
    client: { slug: 'client-c', name: t('Client C'), order: 30 },
    confidentialClient: false,
  },
});

beforeEach(() => {
  rows = Object.fromEntries(SEED_SERVICES.map((s) => [s.slug, seedServiceDetailRow(s.slug)]));
  disciplines = seedDisciplines();
  cases = { [serviceId('logo')]: logoCase() };
  calls.length = 0;
  heads.length = 0;
});

// ── The retired map ───────────────────────────────────────────────────────────────

// The plan's table ("Redirects for retired slugs"), restated literally: a test that read
// RETIRED_SERVICES to check RETIRED_SERVICES would pass whatever the map said.
const PLAN_TABLE: Record<string, string> = {
  branding: '/services#branding',
  animations: '/services/animation',
  videography: '/services/photo-video',
  photography: '/services/photo-video',
  montage: '/services/video-editing',
  'event-planning': '/services#events',
  'web-development': '/services#web',
  music: '/services/music-vo-sfx',
  merchandise: '/services#branding',
  gaming: '/services',
};

describe('retired service slugs → where they moved', () => {
  it('is exactly the plan’s ten slugs and targets', () => {
    expect({ ...RETIRED_SERVICES }).toEqual(PLAN_TABLE);
  });

  it('prefixes the Arabic twin, keeping the fragment on the localized path', () => {
    expect(retiredTarget('branding', 'en')).toBe('/services#branding');
    expect(retiredTarget('branding', 'ar')).toBe('/ar/services#branding');
    expect(retiredTarget('music', 'ar')).toBe('/ar/services/music-vo-sfx');
    expect(retiredTarget('gaming', 'ar')).toBe('/ar/services');
    for (const [slug, target] of Object.entries(PLAN_TABLE)) {
      expect(retiredTarget(slug, 'en')).toBe(target);
      expect(retiredTarget(slug, 'ar')).toBe(`/ar${target}`);
    }
  });

  it('every target is a live page: a seeded service, or a seeded discipline’s panel', () => {
    const services = new Set(SEED_SERVICES.map((s) => s.slug));
    const panels = new Set(SEED_DISCIPLINES.map((d) => d.slug));
    for (const target of Object.values(RETIRED_SERVICES)) {
      const service = /^\/services\/([a-z0-9-]+)$/.exec(target)?.[1];
      const panel = /^\/services#([a-z0-9-]+)$/.exec(target)?.[1];
      if (service) expect(services.has(service), target).toBe(true);
      else if (panel) expect(panels.has(panel), target).toBe(true);
      else expect(target).toBe('/services');
    }
  });

  it('never chains (no target is another retired slug) and never shadows a live service', () => {
    const live = new Set(SEED_SERVICES.map((s) => s.slug));
    for (const [slug, target] of Object.entries(RETIRED_SERVICES)) {
      expect(live.has(slug), `${slug} is a live seeded service`).toBe(false);
      const to = /^\/services\/([a-z0-9-]+)$/.exec(target)?.[1];
      if (to) expect(Object.hasOwn(RETIRED_SERVICES, to), `${slug} → ${to}`).toBe(false);
    }
  });

  it('answers null for anything else — including Object.prototype’s own names', () => {
    for (const slug of ['logo', 'nope', 'constructor', '__proto__', 'toString', 'hasOwnProperty'])
      expect(retiredTarget(slug, 'en'), slug).toBeNull();
    expect(retiredRedirect('constructor', 'en')).toBeNull();
  });

  it('names exactly the four one-to-one renames, each to the slug its row now carries', () => {
    // Round 3 (lead labels): a rename kept the row's id under a new slug, so no row with the
    // old slug exists; a merge (photography → photo-video) left its own row archived. Only
    // the renames are converted at lead-save time; a merged slug is labelled from its row.
    const renames: Record<string, string | null> = {};
    for (const slug of Object.keys(PLAN_TABLE)) renames[slug] = renamedServiceSlug(slug);
    expect(renames).toEqual({
      animations: 'animation',
      videography: 'photo-video',
      montage: 'video-editing',
      music: 'music-vo-sfx',
      branding: null,
      photography: null,
      'event-planning': null,
      'web-development': null,
      merchandise: null,
      gaming: null,
    });
    expect([...RENAMED_SERVICE_SLUGS]).toEqual(['animations', 'videography', 'montage', 'music']);
    // every rename's target is the plan table's, so there is still one map of targets
    for (const slug of RENAMED_SERVICE_SLUGS) {
      expect(`/services/${renamedServiceSlug(slug)}`).toBe(PLAN_TABLE[slug]);
    }
    for (const slug of ['logo', 'nope', 'constructor', '__proto__', 'toString'])
      expect(renamedServiceSlug(slug), slug).toBeNull();
  });

  it('canonicalServiceSlug converts a rename and keeps everything else', () => {
    expect(canonicalServiceSlug('videography')).toBe('photo-video');
    expect(canonicalServiceSlug('animations')).toBe('animation');
    expect(canonicalServiceSlug('photography')).toBe('photography');
    expect(canonicalServiceSlug('branding')).toBe('branding');
    expect(canonicalServiceSlug('logo')).toBe('logo');
    expect(canonicalServiceSlug('constructor')).toBe('constructor');
  });

  it('is a permanent redirect cached for a day, not a Tier-A page', () => {
    const res = retiredRedirect('music', 'ar')!;
    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('/ar/services/music-vo-sfx');
    expect(res.headers.get('Cache-Control')).toBe(RETIRED_CACHE_CONTROL);
    expect(RETIRED_CACHE_CONTROL).toBe('public, max-age=86400');
    expect(res.headers.get('Cache-Tag')).toBeNull();
  });
});

// ── The loader ─────────────────────────────────────────────────────────────────────

describe('loadServicePage', () => {
  it('found: the service, its discipline with its siblings, every group, the case, the head', async () => {
    const page = await loadServicePage('logo', {}, 'en');
    expect(page).not.toBeNull();
    expect(page!.service.slug).toBe('logo');
    expect(page!.service.discipline?.slug).toBe('branding');
    expect(page!.discipline?.slug).toBe('branding');
    expect(page!.discipline?.services.map((s) => s.slug)).toEqual([
      'logo',
      'business-cards',
      'letterhead',
      'brand-guidelines',
      'stationery',
      'packaging',
      'powerpoint-templates',
      'company-profile',
    ]);
    expect(page!.disciplines.map((d) => d.slug)).toEqual([
      'branding',
      'production',
      'marketing',
      'web',
      'events',
    ]);
    expect(page!.serviceCase?.project?.slug).toBe('notebook');
    expect(page!.service.deliverables).toHaveLength(5);
    expect(page!.service.valuePoints).toHaveLength(3);
  });

  it('starts the disciplines and the head with the service query, chaining only the case', async () => {
    await loadServicePage('logo', {}, 'en');
    expect(calls.slice(0, 3).sort()).toEqual(['disciplines', 'head', 'service:logo']);
    expect(calls).toContain(`case:${serviceId('logo')}`);
    expect(heads[0]?.entity).toEqual({ type: 'service', id: serviceId('logo') });
  });

  it('titles the page "{Service} | {Discipline}" for the brand-first template, per locale', async () => {
    await loadServicePage('logo', {}, 'en');
    await loadServicePage('logo', {}, 'ar');
    expect(heads[0]?.title).toBe('Logo Design | Branding');
    expect(heads[1]?.title).toBe('تصميم الشعار | الهوية البصرية');
  });

  it('describes the page with its tagline, strictly in the page’s language', async () => {
    await loadServicePage('logo', {}, 'ar');
    expect(heads[0]?.description).toBe(SEED_SERVICES[0]!.blurb!.ar);
    rows.logo = { ...rows.logo!, blurb: { en: 'English only' } };
    await loadServicePage('logo', {}, 'ar');
    expect(heads[1]?.description).toBe(SERVICE_PAGE_META.ar.description);
  });

  it('renders the body from the Tiptap source — never the stored body_html', async () => {
    rows.logo = {
      ...rows.logo!,
      body_html: { en: '<p>cached</p><script>alert(1)</script>' },
      body: {
        en: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'We start <b>by</b> listening' }],
            },
          ],
        },
      },
    };
    const page = await loadServicePage('logo', {}, 'en');
    const html = page!.service.bodyHtml?.en ?? '';
    expect(html).toContain('<p>We start &lt;b&gt;by&lt;/b&gt; listening</p>');
    expect(html).not.toContain('cached');
    expect(html).not.toContain('<script');
  });

  it('no case: the page renders without one (the band hides, the CTA skips to the form)', async () => {
    cases = {};
    const page = await loadServicePage('logo', {}, 'en');
    expect(page?.serviceCase).toBeNull();
  });

  it('not found: null, and no case is asked for', async () => {
    expect(await loadServicePage('nope', {}, 'en')).toBeNull();
    expect(calls.some((c) => c.startsWith('case:'))).toBe(false);
  });

  it('a service in no discipline is its name alone, with no "More in" group', async () => {
    rows.logo = { ...rows.logo!, discipline_id: null, discipline: null };
    const page = await loadServicePage('logo', {}, 'en');
    expect(page?.discipline).toBeNull();
    expect(heads[0]?.title).toBe('Logo Design');
  });
});

describe('resolveServiceRoute — page, 301 or 404', () => {
  it('a published service is its page', async () => {
    const route = await resolveServiceRoute('music-vo-sfx', {}, 'ar');
    expect(route.kind).toBe('page');
  });

  it('a retired slug is a 301 to where it moved, in the page’s language', async () => {
    const en = await resolveServiceRoute('branding', {}, 'en');
    expect(en.kind).toBe('redirect');
    if (en.kind === 'redirect')
      expect(en.response.headers.get('Location')).toBe('/services#branding');
    const ar = await resolveServiceRoute('music', {}, 'ar');
    if (ar.kind !== 'redirect') throw new Error('expected a redirect');
    expect(ar.response.status).toBe(301);
    expect(ar.response.headers.get('Location')).toBe('/ar/services/music-vo-sfx');
  });

  it('restoring a retired service wins: the lookup runs first', async () => {
    rows.branding = { ...seedServiceDetailRow('logo'), slug: 'branding' };
    const route = await resolveServiceRoute('branding', {}, 'en');
    expect(route.kind).toBe('page');
  });

  it('anything else is missing (a real 404) — never another service’s page', async () => {
    expect((await resolveServiceRoute('nope', {}, 'en')).kind).toBe('missing');
    calls.length = 0;
    expect((await resolveServiceRoute(undefined, {}, 'en')).kind).toBe('missing');
    expect(calls).toEqual([]);
  });
});

describe('serviceTitle / serviceDescription / disciplineOf / cache tags', () => {
  const detail = { title: t('Logo Design'), discipline: { slug: 'branding', name: t('Branding') } };

  it('title: "{Service} | {Discipline}", or the name alone', () => {
    expect(serviceTitle(detail, 'en')).toBe('Logo Design | Branding');
    expect(serviceTitle(detail, 'ar')).toBe('ع-Logo Design | ع-Branding');
    expect(serviceTitle({ ...detail, discipline: null }, 'en')).toBe('Logo Design');
  });

  it('description: the tagline, else the generic line', () => {
    expect(serviceDescription({ tagline: t('A mark') }, 'en')).toBe('A mark');
    expect(serviceDescription({ tagline: null }, 'en')).toBe(SERVICE_PAGE_META.en.description);
    expect(SERVICE_PAGE_META.en.description).toBe(
      'What the service is, the value we add, and a client problem we solved with it.',
    );
  });

  it('hero sub: the tagline (Arabic falls back to English), and NONE without one', () => {
    expect(serviceHeroSub({ tagline: t('A mark') })).toEqual({ en: 'A mark', ar: 'ع-A mark' });
    expect(serviceHeroSub({ tagline: { en: 'A mark' } })).toEqual({ en: 'A mark', ar: 'A mark' });
    // null → ServicePage passes `noSub`, so Hero renders no sub line rather than the home
    // slogan ("From the brain to the real world.") under the service's name.
    expect(serviceHeroSub({ tagline: null })).toBeNull();
  });

  it('finds the discipline by id, else by the embedded slug; none without an id', () => {
    const list = seedDisciplines();
    const branding = list[0]!;
    expect(disciplineOf({ disciplineId: branding.id, discipline: null }, list)?.slug).toBe(
      'branding',
    );
    expect(
      disciplineOf(
        { disciplineId: 'ffffffff-0000-4000-8000-000000000000', discipline: detail.discipline },
        list,
      )?.slug,
    ).toBe('branding');
    expect(disciplineOf({ disciplineId: null, discipline: detail.discipline }, list)).toBeNull();
  });

  it('tags the page with everything it renders', () => {
    expect(serviceCacheEntities('logo')).toEqual([
      'service:logo',
      'services:all',
      'disciplines:all',
      'service_cases:all',
      'portfolio:all',
      'clients:all',
      'sectors:all',
      'media:all',
    ]);
  });
});

// ── The copy ───────────────────────────────────────────────────────────────────────

const accented = (text: string, accent: Parameters<typeof accentRange>[0], locale: 'en' | 'ar') =>
  splitAccent(text, accentRange(accent, locale))
    .filter((r) => r.accent)
    .map((r) => r.text);

describe('service page copy (service.html v.*)', () => {
  it('"Why it’s *worth it*" / "ليش *تستاهل*"', () => {
    expect(accented(SERVICE_PAGE_COPY.en.valueHeading, VALUE_ACCENT, 'en')).toEqual(['worth it']);
    expect(accented(SERVICE_PAGE_COPY.ar.valueHeading, VALUE_ACCENT, 'ar')).toEqual(['تستاهل']);
  });

  it('"Everything in *Branding*" / "كل خدمات *الهوية البصرية*" — the whole name accented', () => {
    const en = moreHeading('Events & Exhibitions', 'en');
    expect(en.text).toBe('Everything in Events & Exhibitions');
    expect(accented(en.text, en.accent, 'en')).toEqual(['Events & Exhibitions']);
    const ar = moreHeading('الهوية البصرية', 'ar');
    expect(ar.text).toBe('كل خدمات الهوية البصرية');
    expect(accented(ar.text, ar.accent, 'ar')).toEqual(['الهوية البصرية']);
  });

  it('"More in {c}" fills the name verbatim (no $-pattern expansion)', () => {
    expect(moreTag('Branding', 'en')).toBe('More in Branding');
    expect(moreTag('الهوية البصرية', 'ar')).toBe('المزيد في الهوية البصرية');
    expect(moreTag('Save $& now', 'en')).toBe('More in Save $& now');
  });

  it('both languages carry every label', () => {
    for (const key of Object.keys(SERVICE_PAGE_COPY.en) as (keyof typeof SERVICE_PAGE_COPY.en)[]) {
      expect(SERVICE_PAGE_COPY.ar[key].length, key).toBeGreaterThan(0);
      expect(SERVICE_PAGE_COPY.ar[key], key).not.toBe(SERVICE_PAGE_COPY.en[key]);
    }
  });
});

// ── The case image ─────────────────────────────────────────────────────────────────

describe('the case block image', () => {
  const still = (key: string): ImageRef => ({
    id: `media-${key}`,
    src: { src: `/_astro/${key}.jpg`, width: 1600, height: 1000, format: 'jpg' } as ImageMetadata,
    width: 1600,
    height: 1000,
    alt: { en: `${key} still`, ar: `${key} ع` },
  });
  const projectPoster = still('notebook');
  const servicePoster = still('logo');
  const project = { slug: 'notebook', title: t('Notebook'), poster: projectPoster };

  it("the project's own poster links to its case study, named by the project", () => {
    const f = caseFigure({ project, fallback: servicePoster, hasContext: true, locale: 'en' })!;
    expect(f.image).toBe(projectPoster);
    expect(f.href).toBe('/portfolio/notebook');
    expect(f.alt).toBe('Notebook');
    const ar = caseFigure({ project, fallback: servicePoster, hasContext: true, locale: 'ar' })!;
    expect(ar.href).toBe('/ar/portfolio/notebook');
    expect(ar.alt).toBe('ع-Notebook');
  });

  it("a published project with NO poster: the service's still, unlinked, with its own alt", () => {
    const f = caseFigure({
      project: { ...project, poster: null },
      fallback: servicePoster,
      hasContext: true,
      locale: 'en',
    })!;
    expect(f.image).toBe(servicePoster);
    // never "Notebook" over the service's still, nor a "See the full project" link on it
    expect(f.href).toBeNull();
    expect(f.alt).toBeNull();
  });

  it("no (published) project: the service's still, unlinked; nothing at all without one", () => {
    const f = caseFigure({
      project: null,
      fallback: servicePoster,
      hasContext: true,
      locale: 'en',
    });
    expect(f?.image).toBe(servicePoster);
    expect(f?.href).toBeNull();
    expect(
      caseFigure({ project: null, fallback: null, hasContext: true, locale: 'en' }),
    ).toBeNull();
    expect(
      caseFigure({
        project: { ...project, poster: null },
        fallback: null,
        hasContext: false,
        locale: 'en',
      }),
    ).toBeNull();
  });

  it('is sized for its layout: the wide column beside the context, the whole wrap alone', () => {
    const split = caseFigure({ project, fallback: null, hasContext: true, locale: 'en' })!;
    expect(split.layout).toBe('split');
    expect(split.sizes).toBe('(min-width: 56.3125rem) min(52vw, 700px), 100vw');
    const solo = caseFigure({ project, fallback: null, hasContext: false, locale: 'en' })!;
    expect(solo.layout).toBe('solo');
    // .svc-case__top--solo spans the 1280px wrap: never described as the 700px column
    expect(solo.sizes).toBe('min(100vw, 1280px)');
    expect(solo.widths).toContain(1600);
    expect(CASE_IMAGE_SLOT.split.widths).toEqual([480, 800, 1200]);
  });
});

// ── The floating button ────────────────────────────────────────────────────────────

describe('the floating "Skip to inquiry"', () => {
  it('shows past the hero mark only once the mark went off the TOP', () => {
    expect(fab.pastMark({ isIntersecting: true, top: 200 })).toBe(false);
    expect(fab.pastMark({ isIntersecting: false, top: 1200 })).toBe(false); // still below
    expect(fab.pastMark({ isIntersecting: false, top: -1 })).toBe(true);
  });

  it('the form counts as reached in view AND once scrolled past — it stays hidden below', () => {
    expect(fab.formReached({ isIntersecting: false, top: 900 })).toBe(false);
    expect(fab.formReached({ isIntersecting: true, top: 300 })).toBe(true);
    expect(fab.formReached({ isIntersecting: false, top: -2400 })).toBe(true);
  });

  it('is shown only between the two', () => {
    expect(fab.fabShown(false, false)).toBe(false);
    expect(fab.fabShown(true, false)).toBe(true);
    expect(fab.fabShown(true, true)).toBe(false);
    expect(fab.fabShown(false, true)).toBe(false);
  });

  it('places the mark at 60% of the hero, and the form line at 85% of the viewport', () => {
    expect(fab.HERO_SHARE).toBe(0.6);
    expect(fab.FORM_LINE).toBe(0.85);
    expect(fab.markOffset(640)).toBe(384);
    expect(fab.markOffset(-5)).toBe(0);
  });

  it('rides above the consent banner while it is open, and drops back once it is not', () => {
    expect(fab.LIFT_VAR).toBe('--svc-fab-lift');
    expect(fab.fabLift(null)).toBe(0); // no banner on the page
    expect(fab.fabLift({ hidden: false, offsetHeight: 154.4 })).toBe(155); // open: clear it
    expect(fab.fabLift({ hidden: true, offsetHeight: 0 })).toBe(0); // a choice was made
    expect(fab.fabLift({ hidden: true, offsetHeight: 80 })).toBe(0); // hidden wins
  });

  it('while hidden it is inert, aria-hidden and out of the tab order', () => {
    const attrs = new Map<string, string>();
    const classes = new Set<string>();
    const el = {
      inert: true,
      classList: { toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)) },
      setAttribute: (k: string, v: string) => attrs.set(k, v),
      removeAttribute: (k: string) => attrs.delete(k),
    } as unknown as HTMLElement;
    fab.setFabShown(el, true);
    expect(el.inert).toBe(false);
    expect(classes.has('is-shown')).toBe(true);
    expect(attrs.size).toBe(0);
    fab.setFabShown(el, false);
    expect(el.inert).toBe(true);
    expect(classes.has('is-shown')).toBe(false);
    expect(attrs.get('aria-hidden')).toBe('true');
    expect(attrs.get('tabindex')).toBe('-1');
  });
});

describe('landing on a fragment', () => {
  it('names the target of a hash, and nothing for an empty or malformed one', () => {
    expect(hashTarget('#inquiry')).toBe('inquiry');
    expect(hashTarget('#%D8%A3')).toBe('أ');
    expect(hashTarget('')).toBeNull();
    expect(hashTarget('#')).toBeNull();
    expect(hashTarget('#%E0%A4%A')).toBeNull();
  });
});
