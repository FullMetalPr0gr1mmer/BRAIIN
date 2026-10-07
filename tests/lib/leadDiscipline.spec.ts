import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIRoute } from 'astro';

// "{Discipline}, help me choose" (Round 2, 0028): leads.discipline_of_interest from the
// public insert to every place a lead is read — the safe projection, the CSV export and the
// panel. Not sensitive: it rides with service_of_interest, never with the PII columns.

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = '11111111-1111-4111-8111-111111111111';

const inserts: { table: string; row: Record<string, unknown> }[] = [];
const ingests: Record<string, unknown>[] = [];
let ingestError: { code?: string } | null = null;
let leadRows: Record<string, unknown>[] = [];

// The service-role client: the public lead insert, the export's live recheck, its
// rate-limit ledger and, since 0033, the PII export's lead read (staff tokens cannot read
// the gated columns, so a leads.pii export reads as the service role).
vi.mock('@/lib/supabase/server', () => ({
  serviceClient: () => ({
    // Since 0035 a public lead arrives through crm_ingest_lead (src/lib/data/leads.ts).
    rpc: async (fn: string, args: { p_lead: Record<string, unknown> }) => {
      if (fn === 'crm_ingest_lead') ingests.push(args.p_lead);
      return { data: null, error: ingestError };
    },
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'gte', 'in', 'order', 'limit']) b[m] = () => b;
      b['insert'] = (row: Record<string, unknown>) => {
        inserts.push({ table, row });
        // Awaited directly (a lead) or chained to read the new id back (the export's
        // privileged-op claim, src/lib/admin/rateLimit.ts).
        return {
          select: () => ({ single: async () => ({ data: { id: 1 }, error: null }) }),
          then: (ok: (v: unknown) => unknown) =>
            Promise.resolve({ data: null, error: null }).then(ok),
        };
      };
      b['maybeSingle'] = async () => ({
        data: { role: 'developer', is_active: true, locked_until: null },
        error: null,
      });
      b['then'] = (ok: (v: unknown) => unknown) =>
        Promise.resolve({
          data: table === 'leads' ? leadRows : [],
          error: null,
          count: 0,
        }).then(ok);
      return b;
    },
  }),
}));
vi.mock('@/lib/supabase/client', () => ({
  supabaseConfigured: () => true,
  anonClient: () => ({}),
}));
vi.mock('@/lib/data/tenant', () => ({ resolveLaunchTenantId: async () => TENANT }));
vi.mock('@/lib/crypto/pii', () => ({
  encryptPII: async (v: string) => `enc(${v})`,
  decryptPII: async (v: string) => v.replace(/^enc\((.*)\)$/, '$1'),
}));
vi.mock('@/lib/admin/audit', () => ({ writeAudit: async () => true }));
vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));

const { createLead } = await import('@/lib/data/leads');
const { SAFE_LEAD_COLUMNS, FULL_LEAD_COLUMNS } = await import('@/lib/admin/leadFields');
const { LeadInputSchema } = await import('@schemas/lead');

const input = (over: Record<string, unknown> = {}) =>
  LeadInputSchema.parse({ name: 'Sam', email: 'sam@example.com', message: 'Hi.', ...over });

beforeEach(() => {
  inserts.length = 0;
  ingests.length = 0;
  ingestError = null;
  leadRows = [];
});

describe('the public insert', () => {
  it('writes discipline_of_interest when the visitor chose "help me choose"', async () => {
    expect((await createLead(input({ disciplineOfInterest: 'branding' }))).ok).toBe(true);
    const lead = ingests.at(-1)!;
    expect(lead['discipline_of_interest']).toBe('branding');
    expect(lead['service_of_interest']).toBeNull();
  });

  it('the fallback insert omits the key otherwise (a code-before-migration deploy keeps working)', async () => {
    ingestError = { code: 'PGRST202' };
    await createLead(input({ serviceOfInterest: 'logo' }));
    const row = inserts.find((i) => i.table === 'leads')!.row;
    expect(row['service_of_interest']).toBe('logo');
    expect(row).not.toHaveProperty('discipline_of_interest');
  });

  it('stores a renamed slug under the slug the service lives at now (Round 3)', async () => {
    // A cached page still posts `videography`; the row that was `videography` is
    // `photo-video` now, so the lead is filed there. Nothing else is rewritten: an
    // archived slug is stored as given and labelled from its own row.
    await createLead(input({ serviceOfInterest: 'videography' }));
    expect(ingests.at(-1)!['service_of_interest']).toBe('photo-video');
    await createLead(input({ serviceOfInterest: 'photography' }));
    expect(ingests.at(-1)!['service_of_interest']).toBe('photography');
    await createLead(input({ serviceOfInterest: 'logo' }));
    expect(ingests.at(-1)!['service_of_interest']).toBe('logo');
  });
});

describe('where a lead is read', () => {
  it('the safe projection carries it (so the list, export and notify all see it)', () => {
    const safe = SAFE_LEAD_COLUMNS.split(',');
    expect(safe).toContain('discipline_of_interest');
    // …and it is not mistaken for a gated column
    expect(safe.at(-1)).toBe('discipline_of_interest');
    expect(FULL_LEAD_COLUMNS.startsWith(SAFE_LEAD_COLUMNS)).toBe(true);
  });

  it('the CSV export has a column for it', async () => {
    leadRows = [
      {
        id: 'l1',
        created_at: '2026-09-27T00:00:00Z',
        status: 'new',
        name: 'Sam',
        company: null,
        service_of_interest: null,
        discipline_of_interest: 'events',
        locale: 'en',
        message: 'Hi.',
      },
    ];
    const { GET } = await import('@/pages/api/admin/leads/export');
    // The caller's connection answers the label lookups (Round 3); Developer holds
    // leads.pii, so the lead query itself goes to the service role (above).
    const titled: Record<string, Record<string, unknown>[]> = {
      disciplines: [
        {
          slug: 'events',
          name: { en: 'Events & Exhibitions', ar: 'الفعاليات' },
          status: 'published',
        },
      ],
      services: [],
    };
    const sb = {
      from: (table: string) => {
        const b: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'in', 'order', 'limit', 'gte', 'lte']) b[m] = () => b;
        b['then'] = (ok: (v: unknown) => unknown) =>
          Promise.resolve({ data: titled[table] ?? [], error: null }).then(ok);
        return b;
      },
    };
    const url = new URL('https://admin.example.test/api/admin/leads/export');
    const res = (await (GET as APIRoute)({
      request: new Request(url),
      url,
      params: {},
      locals: {
        session: {
          userId: USER,
          tenantId: TENANT,
          role: 'developer',
          isActive: true,
          email: 'd@x.test',
        },
        supabase: sb,
        cspNonce: 'n',
        csrfToken: 'c',
      },
    } as unknown as Parameters<APIRoute>[0])) as Response;
    expect(res.status).toBe(200);
    const cells = (line: string) => line.split(',').map((c) => c.replace(/^"|"$/g, ''));
    const [header, first] = (await res.text()).trim().split(/\r?\n/);
    const columns = cells(header!);
    expect(columns).toContain('discipline_of_interest');
    expect(cells(first!)[columns.indexOf('discipline_of_interest')]).toBe('events');
    // Round 3: the readable labels sit right after the slug they explain, EN then AR.
    const at = (name: string) => columns.indexOf(name);
    expect(columns.slice(at('service_of_interest'), at('service_of_interest') + 3)).toEqual([
      'service_of_interest',
      'service_label',
      'service_label_ar',
    ]);
    expect(columns.slice(at('discipline_of_interest'), at('discipline_of_interest') + 3)).toEqual([
      'discipline_of_interest',
      'discipline_label',
      'discipline_label_ar',
    ]);
    expect(cells(first!)[at('discipline_label')]).toBe('Events & Exhibitions');
    expect(cells(first!)[at('discipline_label_ar')]).toBe('الفعاليات');
    expect(cells(first!)[at('service_label')]).toBe('');
  });

  it('the panel shows the discipline when no service was picked', async () => {
    const { interestOf } = await import('@/components/admin/LeadsPanel');
    expect(interestOf({ service_of_interest: 'logo', discipline_of_interest: null })).toBe('logo');
    expect(interestOf({ service_of_interest: null, discipline_of_interest: 'events' })).toBe(
      'events (help me choose)',
    );
    expect(interestOf({ service_of_interest: null })).toBe('—');
  });

  it('the panel prefers the server’s label over the raw slug (Round 3)', async () => {
    const { interestOf } = await import('@/components/admin/LeadsPanel');
    expect(
      interestOf({
        service_of_interest: 'videography',
        discipline_of_interest: null,
        service_label: { en: 'Videography (now Photography / Videography)', ar: 'x' },
      }),
    ).toBe('Videography (now Photography / Videography)');
    expect(
      interestOf({
        service_of_interest: null,
        discipline_of_interest: 'events',
        discipline_label: { en: 'Events & Exhibitions', ar: 'الفعاليات' },
      }),
    ).toBe('Events & Exhibitions (help me choose)');
    // a service wins over a discipline, label or not
    expect(
      interestOf({
        service_of_interest: 'logo',
        discipline_of_interest: 'events',
        discipline_label: { en: 'Events & Exhibitions', ar: 'الفعاليات' },
      }),
    ).toBe('logo');
  });
});
