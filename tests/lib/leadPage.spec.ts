import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '@/lib/auth/types';
import { GATED_LEAD_COLUMNS } from '@/lib/admin/leadFields';
import { NotFoundError } from '@/lib/admin/errors';

// The leads pages' server render (Admin v2 C4b, src/lib/crm/leadPage.ts), over a stub client
// that records every read. What it holds: every read names the caller's tenant; a lead the
// caller cannot see is a NotFoundError, before any other read or the audit row; a lead's
// page reads its safe and pipeline columns only (never a gated one), audits the view as
// GET /api/admin/leads/[id] does, and asks lead_neighbours for the address's filter (no
// search, no page); the list reads the KPIs for the range and page 1 for the filters.

const audits: Record<string, unknown>[] = [];
vi.mock('@/lib/admin/audit', () => ({
  writeAudit: async (_sb: unknown, _auth: unknown, entry: Record<string, unknown>) => {
    audits.push(entry);
    return true;
  },
}));
vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));

const { readLeadDetail, readLeadsListInitial, readLeadsFrame } = await import('@/lib/crm/leadPage');
const { DEFAULT_LEAD_FILTERS } = await import('@/lib/crm/leadUrl');

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LEAD = '11111111-1111-4111-8111-111111111111';
const STAGE = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-10-17T12:00:00Z');
const auth: AuthContext = {
  userId: '33333333-3333-4333-8333-333333333333',
  tenantId: TENANT,
  role: 'developer',
  email: 'd@example.test',
} as AuthContext;

interface Recorded {
  reads: { table: string; select: string; filters: [string, unknown][] }[];
  rpcs: { fn: string; args: Record<string, unknown> }[];
}

function stub(rec: Recorded, leadVisible = true): SupabaseClient {
  return {
    from(table: string) {
      const read = { table, select: '', filters: [] as [string, unknown][] };
      rec.reads.push(read);
      const answer = () => {
        if (table === 'leads')
          return leadVisible
            ? { id: LEAD, name: 'Nora', service_of_interest: 'logo', version: 2, read_at: null }
            : null;
        if (table === 'lead_stages')
          return [
            { id: STAGE, key: 'new', label: 'New', tone: 'klein', kind: 'open', is_initial: true },
          ];
        if (table === 'services')
          return [{ id: '44444444-4444-4444-8444-444444444444', slug: 'logo' }];
        return [];
      };
      const builder: Record<string, unknown> = {
        select(columns: string) {
          read.select = columns;
          return builder;
        },
        eq(column: string, value: unknown) {
          read.filters.push([column, value]);
          return builder;
        },
        in(column: string, value: unknown) {
          read.filters.push([column, value]);
          return builder;
        },
        order: () => builder,
        limit: () => builder,
        maybeSingle: async () => {
          const data = answer();
          return { data: Array.isArray(data) ? (data[0] ?? null) : data, error: null };
        },
        then(resolve: (value: unknown) => unknown) {
          const data = answer();
          return Promise.resolve({ data: Array.isArray(data) ? data : [data], error: null }).then(
            resolve,
          );
        },
      };
      return builder;
    },
    async rpc(fn: string, args: Record<string, unknown>) {
      rec.rpcs.push({ fn, args });
      if (fn === 'lead_neighbours') return { data: { prev: LEAD, next: 'nope' }, error: null };
      if (fn === 'leads_list')
        return { data: { total: 1, rows: [{ id: LEAD, email: 'x@y' }] }, error: null };
      if (fn === 'lead_summary') return { data: { total: 1, new: 1 }, error: null };
      if (fn === 'leads_board') return { data: [], error: null };
      if (fn === 'crm_people')
        return { data: [{ id: auth.userId, display_name: 'Dee' }], error: null };
      return { data: null, error: null };
    },
  } as unknown as SupabaseClient;
}

const fresh = (): Recorded => ({ reads: [], rpcs: [] });

describe('a lead’s page', () => {
  it('a lead the caller cannot see is a NotFoundError, with no other read and no audit', async () => {
    const rec = fresh();
    audits.length = 0;
    await expect(
      readLeadDetail(stub(rec, false), auth, LEAD, DEFAULT_LEAD_FILTERS, NOW, true),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(rec.reads.map((r) => r.table)).toEqual(['leads']);
    expect(rec.rpcs).toEqual([]);
    expect(audits).toEqual([]);
  });

  it('reads the safe and pipeline columns only, for the tenant, and audits a plain view', async () => {
    const rec = fresh();
    audits.length = 0;
    const page = await readLeadDetail(
      stub(rec),
      auth,
      LEAD,
      { ...DEFAULT_LEAD_FILTERS, chip: { kind: 'stage', id: STAGE }, range: '7' },
      NOW,
      true,
    );
    const lead = rec.reads.find((r) => r.table === 'leads')!;
    for (const column of GATED_LEAD_COLUMNS.split(','))
      expect(lead.select.split(','), column).not.toContain(column);
    for (const read of rec.reads)
      expect(read.filters, read.table).toContainEqual(['tenant_id', TENANT]);
    expect(audits).toEqual([
      {
        action: 'lead.view',
        entityType: 'lead',
        entityId: LEAD,
        detail: { pii: false, via: 'page' },
      },
    ]);
    // Previous and Next in the address's filter: no search, no page; an id that is not one is dropped.
    const neighbours = rec.rpcs.find((r) => r.fn === 'lead_neighbours')!;
    expect(neighbours.args).toEqual({
      p_tenant: TENANT,
      p_id: LEAD,
      p_filter: { stage: STAGE, from: '2026-10-10T21:00:00.000Z', sort: 'starred' },
    });
    expect(page.neighbours).toEqual({ prev: LEAD, next: null });
    expect(page.serviceHref).toBe('/admin/services/44444444-4444-4444-8444-444444444444');
  });

  it('reads no service for a role that cannot edit services', async () => {
    const rec = fresh();
    const page = await readLeadDetail(stub(rec), auth, LEAD, DEFAULT_LEAD_FILTERS, NOW, false);
    expect(page.serviceHref).toBeNull();
    // The interest label's read stays (slug, title, status); the editor's id is not read.
    expect(rec.reads.filter((r) => r.table === 'services' && r.select === 'id')).toEqual([]);
  });
});

describe('the list', () => {
  it('the list reads the KPIs for the range and page 1 for the filters, safe fields only', async () => {
    const rec = fresh();
    const initial = await readLeadsListInitial(
      stub(rec),
      auth,
      { ...DEFAULT_LEAD_FILTERS, range: '30', assigned: 'me' },
      NOW,
    );
    const list = rec.rpcs.find((r) => r.fn === 'leads_list')!;
    expect(list.args['p_filter']).toMatchObject({
      assigned: 'me',
      sort: 'starred',
      limit: 15,
      offset: 0,
    });
    expect(list.args['p_filter']).not.toHaveProperty('q');
    // A whole range: the range and the same span before it.
    expect(rec.rpcs.filter((r) => r.fn === 'lead_summary')).toHaveLength(2);
    expect(initial.page?.rows[0]).not.toHaveProperty('email');
  });

  it('the frame reads stages, people and the published disciplines and services', async () => {
    const rec = fresh();
    const frame = await readLeadsFrame(stub(rec), auth);
    expect(frame.stages).toEqual([
      { id: STAGE, key: 'new', label: 'New', tone: 'klein', kind: 'open', isInitial: true },
    ]);
    expect(frame.people).toEqual([{ id: auth.userId, name: 'Dee' }]);
    for (const table of ['disciplines', 'services'])
      expect(rec.reads.find((r) => r.table === table)!.filters).toContainEqual([
        'status',
        'published',
      ]);
  });
});
