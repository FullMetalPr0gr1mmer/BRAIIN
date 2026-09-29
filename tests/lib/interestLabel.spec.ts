import { describe, it, expect, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { humanizeSlug, resolveLeadInterests, withInterestLabels } from '@/lib/leads/interestLabel';
import { FALLBACK_DISCIPLINES } from '@/lib/services/cards';

// Round 3 (G1): a lead's interest slugs — old or new — read as labels, EN and AR, and the
// stored rows are never touched. The lookup runs under the caller's connection, one query
// per table, and every miss falls through a known order down to the raw slug.

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {};
const queries: { table: string; columns: string; eq: [string, unknown][]; in: unknown[] }[] = [];

/** A PostgREST double that records each query and answers by table + `.in('slug', …)`. */
function stubDb(): SupabaseClient {
  return {
    from: (table: string) => {
      const q = { table, columns: '', eq: [] as [string, unknown][], in: [] as unknown[] };
      queries.push(q);
      const b: Record<string, unknown> = {};
      b['select'] = (columns: string) => ((q.columns = columns), b);
      b['eq'] = (column: string, value: unknown) => (q.eq.push([column, value]), b);
      b['in'] = (_column: string, values: unknown[]) => ((q.in = values), b);
      b['then'] = (ok: (v: unknown) => unknown) => {
        const rows = (tables[table] ?? []).filter((r) => q.in.includes(r['slug']));
        return Promise.resolve({ data: rows, error: null }).then(ok);
      };
      return b;
    },
  } as unknown as SupabaseClient;
}

beforeEach(() => {
  queries.length = 0;
  for (const k of Object.keys(tables)) delete tables[k];
  tables['services'] = [
    { slug: 'logo', title: { en: 'Logo Design', ar: 'تصميم الشعار' }, status: 'published' },
    { slug: 'branding', title: { en: 'Branding', ar: 'الهوية' }, status: 'archived' },
    {
      slug: 'photo-video',
      title: { en: 'Photography / Videography', ar: 'التصوير والفيديو' },
      status: 'published',
    },
    { slug: 'secret', title: { en: 'Draft thing', ar: 'مسودة' }, status: 'draft' },
  ];
  tables['disciplines'] = [
    {
      slug: 'events',
      name: { en: 'Events & Exhibitions', ar: 'الفعاليات والمعارض' },
      status: 'published',
    },
  ];
});

const lead = (service: string | null, discipline: string | null = null): Row => ({
  service_of_interest: service,
  discipline_of_interest: discipline,
});

describe('resolveLeadInterests — services', () => {
  it('a published service is its own title, in both languages', async () => {
    const labels = await resolveLeadInterests(stubDb(), TENANT, [lead('logo')]);
    expect(labels.get('service:logo')).toEqual({
      slug: 'logo',
      status: 'published',
      currentSlug: 'logo',
      label: { en: 'Logo Design', ar: 'تصميم الشعار' },
    });
  });

  it('an archived row is labelled from ITS OWN title, marked retired (the branding case)', async () => {
    const labels = await resolveLeadInterests(stubDb(), TENANT, [lead('branding')]);
    expect(labels.get('service:branding')).toEqual({
      slug: 'branding',
      status: 'archived',
      currentSlug: 'branding',
      label: { en: 'Branding (retired)', ar: 'الهوية (متوقفة)' },
    });
  });

  it('a renamed slug is labelled from the row it moved to, with currentSlug', async () => {
    const labels = await resolveLeadInterests(stubDb(), TENANT, [lead('videography')]);
    expect(labels.get('service:videography')).toEqual({
      slug: 'videography',
      status: 'renamed',
      currentSlug: 'photo-video',
      label: {
        en: 'Videography (now Photography / Videography)',
        ar: 'Videography (الآن التصوير والفيديو)',
      },
    });
    // …and the new slug was fetched in the SAME query as the old one
    const q = queries.find((x) => x.table === 'services')!;
    expect(q.in).toEqual(expect.arrayContaining(['videography', 'photo-video']));
  });

  it('a renamed slug whose new row cannot be read still names the move', async () => {
    tables['services'] = [];
    const labels = await resolveLeadInterests(stubDb(), TENANT, [lead('montage')]);
    expect(labels.get('service:montage')?.label.en).toBe('Montage (now Video Editing)');
    expect(labels.get('service:montage')?.currentSlug).toBe('video-editing');
  });

  it('any other retired slug (merged into a panel) reads as retired', async () => {
    const labels = await resolveLeadInterests(stubDb(), TENANT, [lead('merchandise')]);
    expect(labels.get('service:merchandise')).toEqual({
      slug: 'merchandise',
      status: 'retired',
      currentSlug: 'merchandise',
      label: { en: 'Merchandise (retired)', ar: 'Merchandise (متوقفة)' },
    });
  });

  it('an unknown slug falls back to the raw slug, never throws', async () => {
    const labels = await resolveLeadInterests(stubDb(), TENANT, [lead('nope-nope')]);
    expect(labels.get('service:nope-nope')).toEqual({
      slug: 'nope-nope',
      status: 'unknown',
      currentSlug: 'nope-nope',
      label: { en: 'nope-nope', ar: 'nope-nope' },
    });
  });

  it('a draft row is still a label for staff (the read includes drafts)', async () => {
    const labels = await resolveLeadInterests(stubDb(), TENANT, [lead('secret')]);
    expect(labels.get('service:secret')?.label.en).toBe('Draft thing');
    expect(labels.get('service:secret')?.status).toBe('draft');
  });
});

describe('resolveLeadInterests — disciplines', () => {
  it('a discipline in the database is its name', async () => {
    const labels = await resolveLeadInterests(stubDb(), TENANT, [lead(null, 'events')]);
    expect(labels.get('discipline:events')).toEqual({
      slug: 'events',
      status: 'published',
      currentSlug: 'events',
      label: { en: 'Events & Exhibitions', ar: 'الفعاليات والمعارض' },
    });
  });

  it('a discipline the database cannot answer comes from FALLBACK_DISCIPLINES', async () => {
    tables['disciplines'] = [];
    const labels = await resolveLeadInterests(stubDb(), TENANT, [lead(null, 'production')]);
    const fallback = FALLBACK_DISCIPLINES.find((d) => d.slug === 'production')!;
    expect(labels.get('discipline:production')).toEqual({
      slug: 'production',
      status: 'fallback',
      currentSlug: 'production',
      label: fallback.name,
    });
  });

  it('a discipline slug never falls into the retired SERVICE map (branding is in both)', async () => {
    tables['disciplines'] = [];
    const labels = await resolveLeadInterests(stubDb(), TENANT, [lead(null, 'branding')]);
    expect(labels.get('discipline:branding')?.label.en).toBe('Branding');
    expect(labels.get('discipline:branding')?.status).toBe('fallback');
  });
});

describe('resolveLeadInterests — the queries', () => {
  it('runs ONE query per table for a whole batch, tenant-scoped, and none for an empty batch', async () => {
    await resolveLeadInterests(stubDb(), TENANT, [
      lead('logo', 'events'),
      lead('branding', 'events'),
      lead('videography'),
      lead(null, 'web'),
      lead(null),
    ]);
    expect(queries.map((q) => q.table)).toEqual(['services', 'disciplines']);
    for (const q of queries) {
      expect(q.eq).toContainEqual(['tenant_id', TENANT]);
      expect(q.columns).toContain('slug');
      expect(q.columns).toContain('status');
    }
    expect(queries[0]!.in.sort()).toEqual(['branding', 'logo', 'photo-video', 'videography']);
    expect(queries[1]!.in.sort()).toEqual(['events', 'web']);

    queries.length = 0;
    await resolveLeadInterests(stubDb(), TENANT, [lead(null)]);
    expect(queries).toHaveLength(0);
  });

  it('tolerates a client that answers with rows lacking a slug, or throws', async () => {
    const weird = {
      from: () => {
        const b: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'in']) b[m] = () => b;
        b['then'] = (ok: (v: unknown) => unknown) =>
          Promise.resolve({ data: [{ id: 'x', role: 'admin' }], error: null }).then(ok);
        return b;
      },
    } as unknown as SupabaseClient;
    const labels = await resolveLeadInterests(weird, TENANT, [lead('logo', 'events')]);
    expect(labels.get('service:logo')?.label.en).toBe('logo');
    expect(labels.get('discipline:events')?.label.en).toBe('Events & Exhibitions');

    const broken = {
      from: () => ({
        select: () => {
          throw new Error('down');
        },
      }),
    };
    const l2 = await resolveLeadInterests(broken as unknown as SupabaseClient, TENANT, [
      lead('logo'),
    ]);
    expect(l2.get('service:logo')?.status).toBe('unknown');
  });
});

describe('withInterestLabels', () => {
  it('appends derived fields only for the interests the row carries', async () => {
    const labels = await resolveLeadInterests(stubDb(), TENANT, [lead('branding', 'events')]);
    // typed as a record: a lead row is one, and LeadInterestRow alone is a weak type
    const row: Row = { id: 'l1', name: 'Sam', ...lead('branding', 'events') };
    expect(withInterestLabels(row, labels)).toEqual({
      ...row,
      service_label: { en: 'Branding (retired)', ar: 'الهوية (متوقفة)' },
      service_status: 'archived',
      discipline_label: { en: 'Events & Exhibitions', ar: 'الفعاليات والمعارض' },
    });
    const bareRow: Row = { id: 'l2', ...lead(null) };
    const bare = withInterestLabels(bareRow, labels);
    expect(bare).not.toHaveProperty('service_label');
    expect(bare).not.toHaveProperty('discipline_label');
  });

  it('humanises a slug the way the labels do', () => {
    expect(humanizeSlug('video-editing')).toBe('Video Editing');
    expect(humanizeSlug('music')).toBe('Music');
  });
});
