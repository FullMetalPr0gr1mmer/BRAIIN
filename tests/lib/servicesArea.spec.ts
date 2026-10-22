import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ADMIN_MAX_CASE_PROBLEMS,
  ADMIN_MAX_VALUE_POINTS,
  MAX_CASE_PROBLEMS,
  MAX_VALUE_POINTS,
  ServiceRowSchema,
} from '@schemas/content';
import { ServiceCaseWriteSchema, ServiceUpdateSchema, ServiceWriteSchema } from '@schemas/admin';
import { ROLES, type AuthContext } from '@/lib/auth/types';
import { barBucket } from '@/lib/admin/charts';
import { validateTabs, visibleTabs } from '@/lib/admin/editorTabs';
import {
  SERVICE_LEAD_COLUMNS,
  SERVICE_LEADS_SHOWN,
  isUuid,
  loadServiceLeads,
  servicesAreaAccess,
} from '@/lib/admin/servicesArea';
import { uiFor } from '@/lib/admin/uiSchema';
import { SERVICE_VALUE_CARDS_MAX, servicesUi } from '@/lib/admin/ui/services';
import { SERVICE_CASE_PROBLEMS_MAX, serviceCasesUi } from '@/lib/admin/ui/serviceCases';
import { cleanInterestCounts, readLeadInterestCounts } from '@/lib/crm/leadInterest';
import {
  barWidth,
  clipWords,
  copySlug,
  duplicatePayload,
  eyeLabel,
  eyeTarget,
  groupServices,
  hideDisciplineQuestion,
  leadsCount,
  nextServiceOrder,
  placeLabel,
  rangeOrderChanges,
  renumberable,
  servicePills,
  servicesCount,
  slugify,
  tensOrderChanges,
  type Row,
} from '@/components/admin/screens/services/model';
import { drawerFields } from '@/components/admin/screens/services/DisciplineDrawer';
import { serviceFields } from '@/components/admin/screens/services/ServiceEditor';
import { caseFields } from '@/components/admin/screens/services/ServiceCasePanel';
import {
  orderChanges,
  renumberable as collectionRenumberable,
} from '@/components/admin/screens/collection/reorder';
import { copySlug as collectionCopySlug } from '@/components/admin/screens/collection/collections';
import { replayLeadGrant } from './leadGrantReplay';

// The Services area (Admin v2 U5, AV-14): the admin caps of 4 value cards and 5 problems, the
// editor's tabs and cards, who is offered what, the overview's and a discipline page's rules
// (grouping, numbers, the eye, the order inside a discipline's own numbers, Duplicate), the
// per-service lead counts, and the Leads tab's one read. The screens are driven in a browser by
// tests/admin/services.e2e.ts.

const T = '00000000-0000-4000-8000-0000000000aa';
const auth = (role: AuthContext['role'] = 'admin'): AuthContext =>
  ({ userId: 'u', tenantId: T, role, email: 'a@example.test' }) as unknown as AuthContext;

const row = (id: string, extra: Record<string, unknown> = {}): Row => ({ id, ...extra }) as Row;
const card = { title: { en: 'Fast', ar: 'سريع' }, text: { en: 'It is fast', ar: 'إنه سريع' } };
const problem = {
  problem: { en: 'Slow', ar: 'بطيء' },
  solution: { en: 'Made it fast', ar: 'جعلناه سريعا' },
};

describe('the admin caps: 4 value cards and 5 problems (the prototype’s, U5)', () => {
  it('the editor’s limits are the schemas’', () => {
    expect(ADMIN_MAX_VALUE_POINTS).toBe(4);
    expect(ADMIN_MAX_CASE_PROBLEMS).toBe(5);
    expect(SERVICE_VALUE_CARDS_MAX).toBe(ADMIN_MAX_VALUE_POINTS);
    expect(SERVICE_CASE_PROBLEMS_MAX).toBe(ADMIN_MAX_CASE_PROBLEMS);
    expect(servicesUi.fields.find((f) => f.name === 'valuePoints')?.maxItems).toBe(4);
    expect(serviceCasesUi.fields.find((f) => f.name === 'problems')?.maxItems).toBe(5);
  });

  it('a save takes 4 value cards and refuses a fifth, on create and update alike', () => {
    const base = { slug: 'logo', title: { en: 'Logo', ar: 'شعار' } };
    expect(
      ServiceWriteSchema.safeParse({ ...base, valuePoints: Array(4).fill(card) }).success,
    ).toBe(true);
    expect(
      ServiceWriteSchema.safeParse({ ...base, valuePoints: Array(5).fill(card) }).success,
    ).toBe(false);
    expect(
      ServiceUpdateSchema.safeParse({ version: 1, valuePoints: Array(5).fill(card) }).success,
    ).toBe(false);
  });

  it('a case takes 5 problems and refuses a sixth', () => {
    const base = { serviceId: T, title: { en: 'Case', ar: 'حالة' } };
    expect(
      ServiceCaseWriteSchema.safeParse({ ...base, problems: Array(5).fill(problem) }).success,
    ).toBe(true);
    expect(
      ServiceCaseWriteSchema.safeParse({ ...base, problems: Array(6).fill(problem) }).success,
    ).toBe(false);
  });

  it('a row stored before the change still renders: the public read keeps 6', () => {
    expect(MAX_VALUE_POINTS).toBe(6);
    expect(MAX_CASE_PROBLEMS).toBe(6);
    const shape = ServiceRowSchema.shape.value_points;
    expect(shape.safeParse(Array(6).fill(card)).success).toBe(true);
  });
});

describe('the service editor’s tabs and cards (U8’s API, U9’s groups)', () => {
  it('holds every field in one tab, its panels named, nothing an SEO field’s name', () => {
    expect(validateTabs(servicesUi)).toEqual([]);
    expect(servicesUi.tabs?.map((t) => t.label)).toEqual([
      'Content',
      'Case study',
      'SEO',
      'Leads',
      'Publishing',
    ]);
    expect(servicesUi.tabs?.filter((t) => t.panel).map((t) => t.panel)).toEqual([
      'case',
      'seo',
      'leads',
    ]);
  });

  it('each card sits inside one tab (a group never spans two)', () => {
    for (const group of servicesUi.groups ?? []) {
      const homes = (servicesUi.tabs ?? []).filter((t) =>
        group.fields.every((name) => t.fields?.includes(name)),
      );
      expect(homes, group.id).toHaveLength(1);
    }
  });

  it('offers the case study to the writers and the leads to the lead workers only', () => {
    const tabs = servicesUi.tabs ?? [];
    expect(visibleTabs(tabs, { seoAccess: 'full' }).map((t) => t.id)).toEqual([
      'content',
      'seo',
      'publishing',
    ]);
    expect(visibleTabs(tabs, { seoAccess: 'view', panels: ['case'] }).map((t) => t.id)).toEqual([
      'content',
      'case',
      'seo',
      'publishing',
    ]);
    expect(
      visibleTabs(tabs, { seoAccess: 'full', panels: ['case', 'leads'] }).map((t) => t.id),
    ).toEqual(['content', 'case', 'seo', 'leads', 'publishing']);
  });

  it('links a published service on the site, nothing else', () => {
    expect(servicesUi.publicHref?.({ status: 'published', slug: 'logo' })).toBe('/services/logo');
    expect(servicesUi.publicHref?.({ status: 'draft', slug: 'logo' })).toBeNull();
  });

  it('offers Archived only to a role that may archive, unless the row already is', () => {
    const options = (fields: ReturnType<typeof serviceFields>) =>
      fields.find((f) => f.name === 'status')?.options?.map((o) => o.value);
    expect(options(serviceFields(servicesUi.fields, true, 'draft'))).toContain('archived');
    expect(options(serviceFields(servicesUi.fields, false, 'draft'))).not.toContain('archived');
    expect(options(serviceFields(servicesUi.fields, false, 'archived'))).toContain('archived');
    expect(options(drawerFields(uiFor('disciplines').fields, false, null))).not.toContain(
      'archived',
    );
    expect(drawerFields(uiFor('disciplines').fields, true, null).map((f) => f.name)).not.toContain(
      'sortOrder',
    );
    const cf = caseFields(serviceCasesUi.fields, false, 'draft');
    expect(cf.map((f) => f.name)).not.toContain('serviceId');
    expect(options(cf)).not.toContain('archived');
  });
});

describe('who is offered what (servicesAreaAccess, from ROLE_CAPS)', () => {
  it('per role', () => {
    const table = Object.fromEntries(ROLES.map((role) => [role, servicesAreaAccess(role)]));
    expect(table['admin']).toEqual({
      services: true,
      archive: true,
      seo: 'full',
      leads: true,
      portfolio: true,
      sectors: true,
      quotes: true,
    });
    expect(table['content_creator']).toEqual({
      services: true,
      archive: false,
      seo: 'view',
      leads: false,
      portfolio: true,
      sectors: true,
      quotes: true,
    });
    expect(table['seo']).toEqual({
      services: false,
      archive: false,
      seo: 'full',
      leads: false,
      portfolio: false,
      sectors: false,
      quotes: false,
    });
    expect(table['developer']).toMatchObject({ services: false, portfolio: false, leads: true });
    expect(table['sales']).toMatchObject({ services: false, portfolio: false, seo: 'none' });
    expect(servicesAreaAccess(undefined)).toMatchObject({ services: false, seo: 'none' });
  });

  it('takes a uuid only', () => {
    expect(isUuid(T)).toBe(true);
    expect(isUuid('new')).toBe(false);
    expect(isUuid(null)).toBe(false);
  });
});

describe('the overview and a discipline’s page (model.ts)', () => {
  const disciplines = [
    row('d2', { sort_order: 20, name: { en: 'Production', ar: 'الإنتاج' } }),
    row('d1', { sort_order: 10, name: { en: 'Branding', ar: 'الهوية' } }),
  ];
  const services = [
    row('s3', { discipline_id: 'd1', sort_order: 30, title: { en: 'Letterhead' } }),
    row('s1', { discipline_id: 'd1', sort_order: 10, title: { en: 'Logo' } }),
    row('s2', { discipline_id: 'd2', sort_order: 20, title: { en: 'Motion' } }),
    row('s9', { discipline_id: null, sort_order: 5, title: { en: 'Stray' } }),
    row('s8', { discipline_id: 'gone', sort_order: 6, title: { en: 'Orphan' } }),
  ];

  it('groups the services under their disciplines in order, the rest apart', () => {
    const grouped = groupServices(disciplines, services);
    expect(grouped.byDiscipline.get('d1')?.map((s) => s.id)).toEqual(['s1', 's3']);
    expect(grouped.byDiscipline.get('d2')?.map((s) => s.id)).toEqual(['s2']);
    expect(grouped.unfiled.map((s) => s.id)).toEqual(['s9', 's8']);
  });

  it('numbers and pills as the prototype draws them', () => {
    expect([0, 4, 9].map(placeLabel)).toEqual(['01', '05', '10']);
    const many = Array.from({ length: 8 }, (_, i) => row(`x${i}`, { title: { en: `S${i}` } }));
    expect(servicePills(many)).toEqual({ names: ['S0', 'S1', 'S2', 'S3'], more: 4 });
    expect(servicePills(many.slice(0, 2))).toEqual({ names: ['S0', 'S1'], more: 0 });
    expect([0, 1, 8].map(servicesCount)).toEqual(['No services yet', '1 service', '8 services']);
    expect([0, 1, 3].map(leadsCount)).toEqual(['No leads', '1 lead', '3 leads']);
  });

  it('the eye shows a draft or scheduled row, hides a live one, and is not on an archived one', () => {
    expect(eyeTarget('published')).toBe('draft');
    expect(eyeTarget('draft')).toBe('published');
    expect(eyeTarget('scheduled')).toBe('published');
    expect(eyeTarget('archived')).toBeNull();
    expect(eyeLabel(row('a', { status: 'published' }), 'Branding')).toBe('Hide Branding');
    expect(eyeLabel(row('a', { status: 'draft' }), 'Branding')).toBe('Show Branding');
  });

  it('says that hiding a discipline hides its services, the name isolated', () => {
    expect(hideDisciplineQuestion('Branding', 8)).toBe(
      'Hide ⁨Branding⁩? Its 8 services are hidden from the site too.',
    );
    expect(hideDisciplineQuestion('Branding', 1)).toContain('Its service is hidden');
    expect(hideDisciplineQuestion('Branding', 0)).toContain('It has no services yet.');
  });

  it('renumbers the disciplines in tens, sending only what changes (U7’s rule)', () => {
    const rows = [
      { id: 'a', sort_order: 10 },
      { id: 'b', sort_order: 20 },
      { id: 'c', sort_order: 30 },
    ];
    expect(tensOrderChanges(rows, ['b', 'a', 'c'])).toEqual([
      { id: 'b', sortOrder: 10 },
      { id: 'a', sortOrder: 20 },
    ]);
    // The same as the collection screen's, which this restates.
    for (const order of [
      ['c', 'b', 'a'],
      ['a', 'c', 'b'],
      ['b', 'c', 'a'],
    ]) {
      expect(tensOrderChanges(rows, order)).toEqual(orderChanges(rows, order));
    }
  });

  it('renumbers a discipline’s services inside the numbers it already holds', () => {
    // Branding holds 10, 30 and 50; Production's 20 and 40 sit between and must not move.
    const branding = [
      { id: 'logo', sort_order: 10 },
      { id: 'cards', sort_order: 30 },
      { id: 'letter', sort_order: 50 },
    ];
    expect(rangeOrderChanges(branding, ['letter', 'logo', 'cards'])).toEqual([
      { id: 'letter', sortOrder: 10 },
      { id: 'logo', sortOrder: 30 },
      { id: 'cards', sortOrder: 50 },
    ]);
    // Only the rows that move are sent.
    expect(rangeOrderChanges(branding, ['logo', 'letter', 'cards'])).toEqual([
      { id: 'letter', sortOrder: 30 },
      { id: 'cards', sortOrder: 50 },
    ]);
    expect(rangeOrderChanges(branding, ['logo', 'cards', 'letter'])).toEqual([]);
    // A seed's ties are parted by one on the first move.
    const tied = [
      { id: 'a', sort_order: 0 },
      { id: 'b', sort_order: 0 },
      { id: 'c', sort_order: 0 },
    ];
    expect(rangeOrderChanges(tied, ['c', 'a', 'b'])).toEqual([
      { id: 'a', sortOrder: 1 },
      { id: 'b', sortOrder: 2 },
    ]);
  });

  it('a person who may not archive renumbers around an archived service, which keeps its number', () => {
    const rows = [
      row('logo', { sort_order: 10, status: 'published' }),
      row('old', { sort_order: 20, status: 'archived' }),
      row('cards', { sort_order: 30, status: 'draft' }),
    ];
    const writable = renumberable(rows, false).map((r) => ({
      id: r.id,
      sort_order: Number(r['sort_order']),
    }));
    expect(writable.map((r) => r.id)).toEqual(['logo', 'cards']);
    const changes = rangeOrderChanges(writable, ['cards', 'old', 'logo']);
    expect(changes.map((c) => c.id)).not.toContain('old');
    expect(changes).toEqual([
      { id: 'cards', sortOrder: 10 },
      { id: 'logo', sortOrder: 30 },
    ]);
    expect(renumberable(rows, true)).toHaveLength(3);
    expect(renumberable(rows, false)).toEqual(collectionRenumberable(rows, false));
  });

  it('a new service goes after its discipline’s last, else after every service', () => {
    const own = [row('a', { sort_order: 10 }), row('b', { sort_order: 30 })];
    expect(nextServiceOrder(own, [...own, row('c', { sort_order: 90 })])).toBe(31);
    expect(nextServiceOrder([], [row('c', { sort_order: 90 })])).toBe(100);
  });

  it('a duplicate is a draft with a slug of its own and “(copy)”, right after the original', () => {
    expect(copySlug('logo', new Set(['logo-copy']))).toBe('logo-copy-2');
    for (const [slug, taken] of [
      ['logo', []],
      ['logo-copy', ['logo-copy']],
      ['a'.repeat(64), []],
    ] as const) {
      expect(copySlug(slug, new Set(taken))).toBe(collectionCopySlug(slug, new Set(taken)));
    }
    const out = duplicatePayload(
      {
        slug: 'logo',
        title: { en: 'Logo design', ar: 'تصميم الشعار' },
        status: 'published',
        scheduledFor: '2030-01-01T00:00:00.000Z',
        sortOrder: 10,
        disciplineId: T,
        version: 4,
      },
      new Set(['logo', 'logo-copy']),
    );
    expect(out).toEqual({
      slug: 'logo-copy-2',
      title: { en: 'Logo design (copy)', ar: 'تصميم الشعار' },
      status: 'draft',
      sortOrder: 11,
      disciplineId: T,
    });
    expect(ServiceWriteSchema.safeParse(out).success).toBe(true);
  });

  it('an address from an English name, nothing from an Arabic one', () => {
    expect(slugify('Logo Design')).toBe('logo-design');
    expect(slugify('  Café & Brand  ')).toBe('cafe-brand');
    expect(slugify('تصميم')).toBe('');
    expect(slugify('x'.repeat(80))).toHaveLength(64);
  });

  it('says a card clip’s window, and none', () => {
    expect(clipWords({ path: '/media/reel.mp4', startS: 3, endS: 9.5 })).toBe(
      'Video window 3s to 9.5s of reel.mp4',
    );
    expect(clipWords({ path: '/media/reel.mp4' })).toBe('Video: reel.mp4');
    expect(clipWords(null)).toBeNull();
  });

  it('draws a bar as charts.ts does (barBucket, restated off admin-ui)', () => {
    for (const max of [0, 1, 7, 40]) {
      for (let v = 0; v <= max; v++)
        expect(barWidth(v, max), `${v}/${max}`).toBe(barBucket(v, max));
    }
  });
});

describe('the lead counts per service (0106, GET /api/admin/leads/interest-counts)', () => {
  it('keeps slugs and whole numbers only', () => {
    expect(
      cleanInterestCounts({ logo: 3, 'brand-guidelines': 0, Bad: 1, 'x y': 2, neg: -1, f: 1.5 }),
    ).toEqual({ logo: 3, 'brand-guidelines': 0 });
    expect(cleanInterestCounts(null)).toEqual({});
    expect(cleanInterestCounts([1, 2])).toEqual({});
  });

  it('reads public.lead_interest_counts for the session’s tenant, and fails loudly', async () => {
    const calls: unknown[] = [];
    const ok = {
      rpc: async (fn: string, args: unknown) => {
        calls.push([fn, args]);
        return { data: { logo: 2 }, error: null };
      },
    } as unknown as SupabaseClient;
    expect(await readLeadInterestCounts(ok, T)).toEqual({ logo: 2 });
    expect(calls).toEqual([['lead_interest_counts', { p_tenant: T }]]);
    const bad = {
      rpc: async () => ({ data: null, error: { code: '42501', message: 'no' } }),
    } as unknown as SupabaseClient;
    await expect(readLeadInterestCounts(bad, T)).rejects.toThrow('42501');
  });
});

describe('the Leads tab’s one read (loadServiceLeads)', () => {
  function fakeDb(leads: Record<string, unknown>[], stages: Record<string, unknown>[]) {
    const seen: {
      table: string;
      select: string;
      eq: [string, unknown][];
      in?: unknown;
      limit?: number;
    }[] = [];
    const builder = (table: string, rows: Record<string, unknown>[]) => {
      const q: {
        table: string;
        select: string;
        eq: [string, unknown][];
        in?: unknown;
        limit?: number;
      } = {
        table,
        select: '',
        eq: [],
      };
      seen.push(q);
      const api = {
        select: (cols: string) => ((q.select = cols), api),
        eq: (col: string, value: unknown) => (q.eq.push([col, value]), api),
        in: (_col: string, values: unknown) => ((q.in = values), api),
        order: () => api,
        limit: (n: number) => ((q.limit = n), api),
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve(resolve({ data: rows, error: null })),
      };
      return api;
    };
    const sb = {
      from: (table: string) => builder(table, table === 'leads' ? leads : stages),
    } as unknown as SupabaseClient;
    return { sb, seen };
  }

  it('reads the safe columns of the newest non-spam leads naming the service, and their stages', async () => {
    const leads = Array.from({ length: SERVICE_LEADS_SHOWN + 1 }, (_, i) => ({
      id: `l${i}`,
      lead_number: i + 1,
      name: `Person ${i}`,
      company: i === 0 ? 'Acme' : null,
      stage_id: 'st1',
      created_at: '2026-10-01T10:00:00Z',
    }));
    const { sb, seen } = fakeDb(leads, [{ id: 'st1', label: 'New', tone: 'klein' }]);
    const out = await loadServiceLeads(sb, auth(), 'logo');
    expect(seen[0]).toMatchObject({
      table: 'leads',
      select: SERVICE_LEAD_COLUMNS,
      eq: [
        ['tenant_id', T],
        ['is_spam', false],
        ['service_of_interest', 'logo'],
      ],
      limit: SERVICE_LEADS_SHOWN + 1,
    });
    expect(seen[1]).toMatchObject({ table: 'lead_stages', eq: [['tenant_id', T]], in: ['st1'] });
    expect(out.rows).toHaveLength(SERVICE_LEADS_SHOWN);
    expect(out.more).toBe(true);
    expect(out.rows[0]).toEqual({
      id: 'l0',
      number: 1,
      name: 'Person 0',
      company: 'Acme',
      stage: { label: 'New', tone: 'klein' },
      createdAt: '2026-10-01T10:00:00Z',
    });
  });

  it('reads only columns the staff column grant holds, none of them gated (0033, 0034)', () => {
    const granted = replayLeadGrant('select');
    for (const column of SERVICE_LEAD_COLUMNS.split(',')) expect(granted, column).toContain(column);
    for (const gated of [
      'budget_enc',
      'timeline_band',
      'email_enc',
      'phone_enc',
      'internal_notes',
    ]) {
      expect(SERVICE_LEAD_COLUMNS.split(',')).not.toContain(gated);
    }
  });
});
