import { beforeEach, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ActivityExportQuerySchema, ActivityQuerySchema, isCalendarDay } from '@schemas/audit';
import {
  applyFilters,
  CHAIN_WINDOW,
  filterParams,
  loadActivity,
  pagingUrl,
  readActivityQuery,
  riyadhDayEnd,
  riyadhDayStart,
  verifyChain,
} from '@/lib/admin/activity';
import { kindFilter } from '@/lib/admin/auditLabels';
import { MAX_TYPES, resolveTitles, titleSourceOf } from '@/lib/admin/auditTitles';

// The activity log's reads (Admin v2 U13, src/lib/admin/activity.ts): the filters as SQL
// (Riyadh days, the chips' or-trees), the chain check over the newest entries UNFILTERED,
// the names through public.audit_people, titles through the viewer's client and never for a
// lead, an application or a person, and field names only.

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AMAL = '11111111-1111-4111-8111-111111111111';
const BASHIR = '22222222-2222-4222-8222-222222222222';
const GONE = '33333333-3333-4333-8333-333333333333';
const SERVICE = '44444444-4444-4444-8444-444444444444';
const LEAD = '55555555-5555-4555-8555-555555555555';
const APPLICATION = '66666666-6666-4666-8666-666666666666';

interface Query {
  table: string;
  calls: [string, unknown[]][];
}

let queries: Query[] = [];
let rpcs: { fn: string; args: Record<string, unknown> }[] = [];
let pageRows: Record<string, unknown>[] = [];
let pageCount = 0;
let chainRows: Record<string, unknown>[] = [];
let outOfRange = false;
let peopleFail = false;

/** A PostgREST stand-in: records every call; answers by table and by what was asked. */
function fakeDb(): SupabaseClient {
  return {
    from(table: string) {
      const query: Query = { table, calls: [] };
      queries.push(query);
      const builder: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'gte', 'lt', 'or', 'in', 'order', 'range', 'limit']) {
        builder[method] = (...args: unknown[]) => {
          query.calls.push([method, args]);
          return builder;
        };
      }
      builder['then'] = (ok: (value: unknown) => unknown) => {
        const select = query.calls.find(([m]) => m === 'select');
        const columns = String(select?.[1][0] ?? '');
        const head = (select?.[1][1] as { head?: boolean } | undefined)?.head === true;
        let result: Record<string, unknown> = { data: [], error: null, count: null };
        if (table === 'audit_log' && columns === 'id,prev_hash,hash') {
          result = { data: chainRows, error: null };
        } else if (table === 'audit_log' && head) {
          result = { data: null, error: null, count: pageCount };
        } else if (table === 'audit_log') {
          const range = query.calls.find(([m]) => m === 'range')?.[1] as number[] | undefined;
          if (outOfRange && (range?.[0] ?? 0) >= pageCount) {
            result = { data: null, error: { code: 'PGRST103' }, count: null };
          } else {
            result = { data: pageRows, error: null, count: pageCount };
          }
        } else if (table === 'services') {
          result = {
            data: [{ id: SERVICE, title: { en: 'Logo design', ar: 'تصميم الشعار' } }],
            error: null,
          };
        }
        return Promise.resolve(result).then(ok);
      };
      return builder;
    },
    async rpc(fn: string, args: Record<string, unknown>) {
      rpcs.push({ fn, args });
      if (fn === 'audit_people') {
        if (peopleFail) return { data: null, error: { code: '42501' } };
        return {
          data: [
            { id: AMAL, display_name: 'Amal', role: 'admin', is_active: true },
            { id: BASHIR, display_name: 'Bashir', role: 'content_creator', is_active: false },
          ],
          error: null,
        };
      }
      return { data: null, error: null };
    },
  } as unknown as SupabaseClient;
}

const entry = (over: Record<string, unknown>) => ({
  id: 10,
  actor_id: AMAL,
  actor_role: 'admin',
  action: 'service.update',
  entity_type: 'service',
  entity_id: SERVICE,
  detail: { fields: ['title'] },
  created_at: '2026-10-15T09:00:00Z',
  ...over,
});

const auditQueries = () => queries.filter((q) => q.table === 'audit_log');
const called = (q: Query, method: string) =>
  q.calls.filter(([m]) => m === method).map(([, a]) => a);

beforeEach(() => {
  queries = [];
  rpcs = [];
  pageRows = [];
  pageCount = 0;
  chainRows = [];
  outOfRange = false;
  peopleFail = false;
});

describe('the filters', () => {
  it('a Riyadh day runs from 21:00 UTC the day before to 21:00 UTC on the day', () => {
    expect(riyadhDayStart('2026-10-15')).toBe('2026-10-14T21:00:00.000Z');
    expect(riyadhDayEnd('2026-10-15')).toBe('2026-10-15T21:00:00.000Z');
    expect(riyadhDayStart('2026-01-01')).toBe('2025-12-31T21:00:00.000Z');
  });

  it('apply the tenant first, then the person, the days and the kind', () => {
    const query: Query = { table: 'audit_log', calls: [] };
    const builder: Record<string, unknown> = {};
    for (const method of ['eq', 'gte', 'lt', 'or']) {
      builder[method] = (...args: unknown[]) => {
        query.calls.push([method, args]);
        return builder;
      };
    }
    applyFilters(builder, TENANT, {
      kind: 'publishing',
      actor: AMAL,
      from: '2026-10-01',
      to: '2026-10-15',
    });
    expect(query.calls).toEqual([
      ['eq', ['tenant_id', TENANT]],
      ['eq', ['actor_id', AMAL]],
      ['gte', ['created_at', '2026-09-30T21:00:00.000Z']],
      ['lt', ['created_at', '2026-10-15T21:00:00.000Z']],
      ['or', [kindFilter('publishing')]],
    ]);
  });

  it('the schema: a blank field is no filter, days are real days, the wrong way round is swapped', () => {
    expect(ActivityQuerySchema.parse({ kind: '', actor: '', from: '', to: '', page: '' })).toEqual({
      page: 1,
    });
    expect(ActivityQuerySchema.parse({ from: '2026-10-15', to: '2026-10-01' })).toMatchObject({
      from: '2026-10-01',
      to: '2026-10-15',
    });
    for (const bad of [
      { kind: 'leads; drop' },
      { actor: 'not-a-uuid' },
      { from: '2026-02-30' },
      { to: '1999-12-31' },
      { page: '0' },
      { page: '10001' },
      { q: 'free text' },
      { entityType: 'Lead Rows' },
    ]) {
      expect(ActivityQuerySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(ActivityExportQuerySchema.safeParse({ page: '2' }).success).toBe(false);
    expect(isCalendarDay('2028-02-29')).toBe(true);
    expect(isCalendarDay('2027-02-29')).toBe(false);
  });

  it('the page reads its URL leniently, naming what it left out', () => {
    const { query, dropped } = readActivityQuery(
      new URLSearchParams('kind=leads&actor=nobody&from=2026-10-01&export=limit&page=2'),
    );
    expect(query).toEqual({ kind: 'leads', from: '2026-10-01', page: 2 });
    expect(dropped).toEqual(['actor']);
    expect(filterParams(query).toString()).toBe('kind=leads&from=2026-10-01');
  });
});

describe('the chain check', () => {
  it('passes when each entry carries the hash of the one before it, and names the first break', () => {
    const rows = [
      { id: 3, prev_hash: 'b', hash: 'c' },
      { id: 2, prev_hash: 'a', hash: 'b' },
      { id: 1, prev_hash: null, hash: 'a' },
    ];
    expect(verifyChain(rows)).toEqual({ checked: 3, contiguous: true, brokenAt: null });
    expect(verifyChain([rows[0]!, rows[2]!])).toEqual({
      checked: 2,
      contiguous: false,
      brokenAt: 3,
    });
  });

  it('reads the newest entries unfiltered, whatever the page filters on', async () => {
    chainRows = [
      { id: 3, prev_hash: 'b', hash: 'c' },
      { id: 2, prev_hash: 'a', hash: 'b' },
    ];
    pageRows = [entry({})];
    pageCount = 1;
    const page = await loadActivity(
      fakeDb(),
      { tenantId: TENANT },
      {
        kind: 'leads',
        actor: AMAL,
        from: '2026-10-01',
        to: '2026-10-15',
        page: 1,
      },
    );
    expect(page.chain).toEqual({ checked: 2, contiguous: true, brokenAt: null });
    const chain = auditQueries().find((q) => called(q, 'select')[0]?.[0] === 'id,prev_hash,hash')!;
    expect(chain.calls).toEqual([
      ['select', ['id,prev_hash,hash']],
      ['eq', ['tenant_id', TENANT]],
      ['order', ['id', { ascending: false }]],
      ['limit', [CHAIN_WINDOW]],
    ]);
  });
});

describe('a page', () => {
  it('reads 25 entries, newest first, with an exact count, never the hashes', async () => {
    pageRows = [entry({})];
    pageCount = 60;
    await loadActivity(fakeDb(), { tenantId: TENANT }, { page: 2 });
    const read = auditQueries().find((q) => called(q, 'range').length > 0)!;
    expect(called(read, 'select')[0]).toEqual([
      'id,actor_id,actor_role,action,entity_type,entity_id,detail,created_at',
      { count: 'exact' },
    ]);
    expect(called(read, 'order')[0]).toEqual(['id', { ascending: false }]);
    expect(called(read, 'range')[0]).toEqual([25, 49]);
    expect(called(read, 'eq')[0]).toEqual(['tenant_id', TENANT]);
  });

  it('names people through audit_people, former members included, and says who has gone', async () => {
    pageRows = [
      entry({ id: 3, actor_id: AMAL }),
      entry({ id: 2, actor_id: BASHIR, actor_role: 'content_creator' }),
      entry({ id: 1, actor_id: GONE, actor_role: 'developer' }),
      entry({ id: 0, actor_id: null, actor_role: null, action: 'auth.password_reset_requested' }),
    ];
    pageCount = 4;
    const page = await loadActivity(fakeDb(), { tenantId: TENANT }, { page: 1 });
    expect(rpcs).toEqual([
      { fn: 'audit_people', args: { p_tenant: TENANT, p_ids: [AMAL, BASHIR, GONE] } },
    ]);
    expect(page.entries.map((e) => [e.who.name, e.who.roleLabel, e.who.former])).toEqual([
      ['Amal', 'Admin', false],
      ['Bashir', 'Content Creator', true],
      ['A former member', 'Developer', true],
      ['No account', null, false],
    ]);
  });

  it('a names read that fails still renders the page: "Someone"', async () => {
    pageRows = [entry({})];
    pageCount = 1;
    peopleFail = true;
    const page = await loadActivity(fakeDb(), { tenantId: TENANT }, { page: 1 });
    expect(page.entries[0]?.who.name).toBe('Someone');
  });

  it('titles content under the viewer’s client, and never reads a lead, an application or a profile', async () => {
    pageRows = [
      entry({ id: 4 }),
      entry({ id: 3, action: 'lead.view_pii', entity_type: 'lead', entity_id: LEAD }),
      entry({
        id: 2,
        action: 'application.view',
        entity_type: 'application',
        entity_id: APPLICATION,
      }),
      entry({ id: 1, action: 'user.update', entity_type: 'profile', entity_id: BASHIR }),
    ];
    pageCount = 4;
    const page = await loadActivity(fakeDb(), { tenantId: TENANT }, { page: 1 });
    const tables = queries.map((q) => q.table);
    expect(tables.filter((t) => t !== 'audit_log')).toEqual(['services']);
    for (const table of ['leads', 'lead_notes', 'job_applications', 'profiles', 'contacts']) {
      expect(tables).not.toContain(table);
    }
    const services = queries.find((q) => q.table === 'services')!;
    expect(services.calls).toEqual([
      ['select', ['id,title']],
      ['eq', ['tenant_id', TENANT]],
      ['in', ['id', [SERVICE]]],
    ]);
    expect(page.entries.map((e) => e.title)).toEqual(['Logo design', null, null, null]);
  });

  it('shows field names, never what a detail holds', async () => {
    pageRows = [
      entry({ detail: { fields: ['title'], email: 'sara@acme.example', phone: '+966500000000' } }),
    ];
    pageCount = 1;
    const page = await loadActivity(fakeDb(), { tenantId: TENANT }, { page: 1 });
    const json = JSON.stringify(page.entries);
    expect(json).not.toContain('sara@acme.example');
    expect(json).not.toContain('+966500000000');
    expect(page.entries[0]?.description.fields).toEqual(['Service name']);
  });

  it('a page past the end shows the last page', async () => {
    pageRows = [entry({})];
    pageCount = 30;
    outOfRange = true;
    const page = await loadActivity(fakeDb(), { tenantId: TENANT }, { page: 9 });
    expect(page.page).toBe(2);
    expect(page.total).toBe(30);
    const ranges = auditQueries().flatMap((q) => called(q, 'range'));
    expect(ranges).toEqual([
      [200, 224],
      [25, 49],
    ]);
  });
});

describe('titles: the bounds', () => {
  it('read at most MAX_TYPES entity types, uuids only, from the allowlist alone', async () => {
    const types = [
      'service',
      'discipline',
      'portfolio',
      'service_case',
      'blog_post',
      'page',
      'testimonial',
      'client',
      'sector',
      'team_member',
    ];
    await resolveTitles(fakeDb(), { tenantId: TENANT }, [
      ...types.map((type) => ({ type, id: SERVICE })),
      { type: 'service', id: 'not-a-uuid' },
      { type: 'leads', id: LEAD },
      { type: 'lead', id: LEAD },
    ]);
    expect(queries).toHaveLength(MAX_TYPES);
    expect(queries.map((q) => q.table)).toEqual(
      types.slice(0, MAX_TYPES).map((type) => titleSourceOf(type)!.table),
    );
  });
});

describe('the export notice is said once (U13 review)', () => {
  it('the pager builds its links from the URL without it, the filters and page kept', () => {
    const url = new URL('https://admin.test/admin/audit?kind=users&export=limit&page=2');
    expect(pagingUrl(url).search).toBe('?kind=users&page=2');
    expect(url.search).toBe('?kind=users&export=limit&page=2');
  });

  it('the page hands its table that URL', async () => {
    const { readFileSync } = await import('node:fs');
    const page = readFileSync('src/pages/admin/audit.astro', 'utf8');
    expect(page).toContain('url={pagingUrl(url)}');
    expect(page).not.toMatch(/url=\{url\}/);
  });
});
