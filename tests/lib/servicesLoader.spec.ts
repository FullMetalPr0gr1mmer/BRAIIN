import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The Round 2 loaders (0028): services with their page fields, the disciplines that group
// them, and a service page's case block. The registry lookup is stubbed (which key reaches
// a page is what matters, not Vite's pipeline); the PostgREST client records what each
// query asks for and answers per table, so a failure of ONE query can be simulated.

vi.mock('@/lib/media/static', () => ({
  staticImage: (key: string) =>
    key.startsWith('stills/') ? { src: `/_astro/${key}`, width: 1600, height: 900 } : null,
}));

interface Recorded {
  table: string;
  columns: string;
  filters: Record<string, unknown>;
  order?: string;
}
let recorded: Recorded[] = [];
let tables: Record<string, unknown[]> = {};
let failing = new Set<string>();

vi.mock('@/lib/supabase/client', () => ({
  supabaseConfigured: () => true,
  anonClient: () => ({
    from: (table: string) => {
      const rec: Recorded = { table, columns: '', filters: {} };
      recorded.push(rec);
      const result = () => {
        if (failing.has(table)) return { data: null, error: { code: '42501', message: 'x' } };
        // A filter on a column the fixture row does not carry (status) matches.
        const rows = (tables[table] ?? []).filter((r) =>
          Object.entries(rec.filters).every(([k, v]) => {
            const value = (r as Record<string, unknown>)[k];
            return value === undefined || value === v;
          }),
        );
        return { data: rows, error: null };
      };
      const q = {
        select: (c: string) => {
          rec.columns = c;
          return q;
        },
        eq: (col: string, v: unknown) => {
          rec.filters[col] = v;
          return q;
        },
        order: (col: string) => {
          rec.order = col;
          return q;
        },
        maybeSingle: async () => {
          const r = result();
          return { data: r.data?.[0] ?? null, error: r.error };
        },
        then: (ok: (v: unknown) => unknown) => Promise.resolve(result()).then(ok),
      };
      return q;
    },
  }),
}));

const { getPublishedServices, getServiceBySlug, toServiceDetail, SERVICE_COLUMNS } =
  await import('@/lib/data/services');
const { getPublishedDisciplines, DISCIPLINE_COLUMNS } = await import('@/lib/data/disciplines');
const { getServiceCase, SERVICE_CASE_COLUMNS } = await import('@/lib/data/serviceCases');

const t = (en: string) => ({ en, ar: `ع-${en}` });
const media = (key: string) => ({
  id: '55555555-5555-4555-8555-555555555555',
  kind: 'image',
  provider: 'static',
  storage_path: key,
  width: 1600,
  height: 900,
  alt: { en: 'A still', ar: 'لقطة' },
  stream_uid: null,
});
const BRANDING = '0d000000-0000-4000-8000-000000000001';
const EVENTS = '0d000000-0000-4000-8000-000000000005';

const service = (slug: string, sort: number, disciplineId: string | null, over = {}) => ({
  id: `5e000000-0000-4000-8000-${String(sort).padStart(12, '0')}`,
  slug,
  title: t(slug),
  short_title: null,
  blurb: { en: `${slug} tagline`, ar: `ع ${slug}` },
  body_html: null,
  hero_video_uid: null,
  category: null,
  is_teaser: false,
  sort_order: sort,
  updated_at: '2026-09-27T00:00:00Z',
  discipline_id: disciplineId,
  intro: t(`${slug} intro`),
  value_points: [{ title: t('Arabic and Latin together'), text: t('Drawn side by side.') }],
  deliverables: [t('Two or three routes')],
  preview_video_path: '/media/showreel.mp4',
  preview_start_s: 5.9,
  preview_end_s: 6.9,
  poster: media('stills/services/write.jpg'),
  ...over,
});

const discipline = (id: string, slug: string, sort: number) => ({
  id,
  slug,
  name: t(slug),
  short: t(`${slug} short`),
  blurb: t(`${slug} blurb`),
  sort_order: sort,
  updated_at: null,
  preview_video_path: '/media/showreel.mp4',
  preview_start_s: 13.4,
  preview_end_s: 15.9,
  poster: media('stills/services/arm.jpg'),
});

beforeEach(() => {
  recorded = [];
  failing = new Set();
  tables = {
    disciplines: [discipline(EVENTS, 'events', 50), discipline(BRANDING, 'branding', 10)],
    services: [
      service('booth-production', 270, EVENTS),
      service('logo', 10, BRANDING),
      service('business-cards', 20, BRANDING),
      service('venue-booking', 250, EVENTS),
    ],
  };
});

describe('services', () => {
  it('names its columns (never *) and asks for published rows in sort order', async () => {
    const rows = await getPublishedServices();
    expect(rows.map((r) => r.slug)).toContain('logo');
    const q = recorded.find((r) => r.table === 'services')!;
    expect(q.columns).toBe(SERVICE_COLUMNS);
    expect(q.columns).not.toContain('*');
    expect(q.filters).toEqual({ status: 'published' });
    expect(q.order).toBe('sort_order');
  });

  it('drops (and does not crash on) a row whose value points are malformed', async () => {
    tables['services'] = [
      service('logo', 10, BRANDING, { value_points: [{ title: t('only a title') }] }),
      service('business-cards', 20, BRANDING),
    ];
    expect((await getPublishedServices()).map((r) => r.slug)).toEqual(['business-cards']);
  });

  it('fails closed to [] on a query error', async () => {
    failing.add('services');
    expect(await getPublishedServices()).toEqual([]);
  });

  it('a service page carries the Tiptap SOURCE and its discipline — and renders the body', async () => {
    tables['services'] = [
      {
        ...service('logo', 10, BRANDING),
        // A cache the admin never wrote: the page must not emit it.
        body_html: { en: '<script>alert(1)</script>' },
        body: {
          en: {
            type: 'doc',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'We start by listening.' }] },
            ],
          },
          ar: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'نبدأ بالاستماع.' }] }],
          },
        },
        discipline: { slug: 'branding', name: t('Branding'), sort_order: 10 },
      },
    ];
    const row = await getServiceBySlug('logo');
    const q = recorded.find((r) => r.table === 'services')!;
    expect(q.columns).toContain(',body,');
    expect(q.columns).toContain('discipline:discipline_id(slug,name,sort_order)');
    expect(q.filters).toEqual({ status: 'published', slug: 'logo' });
    const detail = toServiceDetail(row!);
    expect(detail.bodyHtml).toEqual({
      en: '<p>We start by listening.</p>',
      ar: '<p>نبدأ بالاستماع.</p>',
    });
    expect(detail.discipline).toEqual({ slug: 'branding', name: t('Branding') });
    expect(detail.valuePoints).toHaveLength(1);
    expect(detail.deliverables).toEqual([t('Two or three routes')]);
    expect(detail.tagline).toEqual({ en: 'logo tagline', ar: 'ع logo' });
    expect(detail.clip).toEqual({ path: '/media/showreel.mp4', startS: 5.9, endS: 6.9 });
    expect(detail.poster?.src).toEqual(
      expect.objectContaining({ src: '/_astro/stills/services/write.jpg' }),
    );
  });

  it('a malformed body renders nothing, it does not drop the service', async () => {
    tables['services'] = [
      { ...service('logo', 10, BRANDING), body: 'not a doc', discipline: null },
    ];
    const row = await getServiceBySlug('logo');
    expect(row).not.toBeNull();
    expect(toServiceDetail(row!).bodyHtml).toBeNull();
  });

  it('a clip outside the EXC-009 fence never reaches a page', async () => {
    tables['services'] = [
      service('logo', 10, BRANDING, { preview_video_path: 'https://evil.example/x.mp4' }),
    ];
    const [row] = await getPublishedServices();
    const { toServiceSummary } = await import('@/lib/data/services');
    expect(toServiceSummary(row!).clip).toBeNull();
  });
});

describe('getPublishedDisciplines', () => {
  it('disciplines in sort order, each with ITS services in sort order', async () => {
    const list = await getPublishedDisciplines();
    const q = recorded.find((r) => r.table === 'disciplines')!;
    expect(q.columns).toBe(DISCIPLINE_COLUMNS);
    expect(q.filters).toEqual({ status: 'published' });
    expect(q.order).toBe('sort_order');
    // The stub returns rows as stored; the query's ORDER is what sorts them in production.
    const bySlug = Object.fromEntries(list.map((d) => [d.slug, d]));
    expect(bySlug['branding']!.services.map((s) => s.slug)).toEqual(['logo', 'business-cards']);
    expect(bySlug['events']!.services.map((s) => s.slug)).toEqual([
      'venue-booking',
      'booth-production',
    ]);
    expect(bySlug['events']!.clip).toEqual({
      path: '/media/showreel.mp4',
      startS: 13.4,
      endS: 15.9,
    });
    expect(bySlug['events']!.poster?.alt).toEqual({ en: 'A still', ar: 'لقطة' });
    expect(bySlug['branding']!.short).toEqual(t('branding short'));
  });

  it('a service not yet placed in a discipline is in no group', async () => {
    tables['services']!.push(service('orphan', 5, null));
    const list = await getPublishedDisciplines();
    expect(list.flatMap((d) => d.services.map((s) => s.slug))).not.toContain('orphan');
  });

  it('fails closed as a whole: either query failing → [] (the page renders its fallback)', async () => {
    failing.add('services');
    expect(await getPublishedDisciplines()).toEqual([]);
    failing = new Set(['disciplines']);
    expect(await getPublishedDisciplines()).toEqual([]);
  });

  it('only anon-granted discipline columns are selected (0028 column grant)', () => {
    const sql = readFileSync(
      join(process.cwd(), 'supabase', 'migrations', '0028_disciplines_service_pages.sql'),
      'utf8',
    );
    const granted = /grant select \(([^)]*)\)\s+on public\.disciplines to anon/i
      .exec(sql)![1]!
      .split(',')
      .map((c) => c.trim());
    const selected = DISCIPLINE_COLUMNS.slice(0, DISCIPLINE_COLUMNS.indexOf('poster:'))
      .split(',')
      .filter(Boolean);
    expect(selected.length).toBeGreaterThan(8);
    for (const column of selected) expect(granted).toContain(column);
    expect(granted).toContain('poster_media_id'); // the embed's FK column
  });
});

describe('getServiceCase', () => {
  const caseRow = (over: Record<string, unknown> = {}) => ({
    id: '6c000000-0000-4000-8000-000000000001',
    service_id: '5e000000-0000-4000-8000-000000000010',
    portfolio_id: '70000000-0000-4000-8000-000000000003',
    title: t('A school group rebrand'),
    context: t('Client C had grown to four campuses.'),
    problems: [{ problem: t('Four logos'), solution: t('One master mark') }],
    results: [{ value: '+27%', label: t('parent recall in survey') }],
    updated_at: null,
    project: {
      id: '70000000-0000-4000-8000-000000000003',
      slug: 'notebook',
      title: t('Notebook'),
      client_id: '80000000-0000-4000-8000-000000000003',
      poster: media('stills/work/p2.jpg'),
      sector: { slug: 'education', name: t('Education'), sort_order: 3 },
      client: { slug: 'client-c', name: t('Client C'), sort_order: 3 },
    },
    ...over,
  });

  it('the published case of a service, with its project, sector and client', async () => {
    tables['service_cases'] = [caseRow()];
    const c = await getServiceCase('5e000000-0000-4000-8000-000000000010');
    const q = recorded.find((r) => r.table === 'service_cases')!;
    expect(q.columns).toBe(SERVICE_CASE_COLUMNS);
    expect(q.filters).toEqual({
      status: 'published',
      service_id: '5e000000-0000-4000-8000-000000000010',
    });
    expect(c?.project?.slug).toBe('notebook');
    expect(c?.project?.sector).toEqual({ slug: 'education', name: t('Education'), order: 3 });
    expect(c?.project?.client?.slug).toBe('client-c');
    expect(c?.project?.confidentialClient).toBe(false);
    expect(c?.results).toEqual([{ value: '+27%', label: t('parent recall in survey') }]);
  });

  it('a client RLS hid is "confidential" — never named, never guessed', async () => {
    const hidden = caseRow();
    (hidden.project as Record<string, unknown>)['client'] = null;
    tables['service_cases'] = [hidden];
    const c = await getServiceCase('5e000000-0000-4000-8000-000000000010');
    expect(c?.project?.client).toBeNull();
    expect(c?.project?.confidentialClient).toBe(true);
  });

  it('an unpublished project comes back null: the case keeps its words, loses the link', async () => {
    tables['service_cases'] = [caseRow({ project: null })];
    const c = await getServiceCase('5e000000-0000-4000-8000-000000000010');
    expect(c?.title).toEqual(t('A school group rebrand'));
    expect(c?.project).toBeNull();
  });

  it('none, a malformed row, or a failed query → null', async () => {
    tables['service_cases'] = [];
    expect(await getServiceCase('5e000000-0000-4000-8000-000000000010')).toBeNull();
    tables['service_cases'] = [caseRow({ problems: [{ problem: t('no solution') }] })];
    expect(await getServiceCase('5e000000-0000-4000-8000-000000000010')).toBeNull();
    failing.add('service_cases');
    expect(await getServiceCase('5e000000-0000-4000-8000-000000000010')).toBeNull();
  });

  it('selects only anon-granted case columns — never is_placeholder (0028 column grant)', () => {
    const sql = readFileSync(
      join(process.cwd(), 'supabase', 'migrations', '0028_disciplines_service_pages.sql'),
      'utf8',
    );
    const granted = /grant select \(([^)]*)\)\s+on public\.service_cases to anon/i
      .exec(sql)![1]!
      .split(',')
      .map((c) => c.trim());
    expect(granted).not.toContain('is_placeholder');
    const top = SERVICE_CASE_COLUMNS.slice(0, SERVICE_CASE_COLUMNS.indexOf('project:'))
      .split(',')
      .filter(Boolean);
    for (const column of top) expect(granted).toContain(column);
    expect(granted).toContain('portfolio_id');
  });
});
