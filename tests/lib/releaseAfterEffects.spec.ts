import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApplyResult } from '@schemas/release';
import type { AuthContext } from '@/lib/auth/types';

// What follows a published release (Admin v2 R7, src/lib/release/afterEffects.ts), with a cache
// zone set up: the snapshots the release moved rebuilt as the system, its tags purged, the
// outcome recorded with the minute cron's next try when it failed, and a `release.purge` row
// written as the publisher whenever a purge request was sent. Never thrown.

const state = vi.hoisted(() => ({
  svc: [] as { fn: string; args: Record<string, unknown> }[],
  take: true as unknown,
  logs: [] as Record<string, unknown>[],
  syncs: [] as string[],
  /** The rows the system's reads answer (R14-prep: the settings row, the identity). */
  rows: {} as Record<string, Record<string, unknown> | null>,
  /** Every table the system read, with the tenant it named. */
  reads: [] as string[],
  /** Tables whose read fails (review C4: a refresh that cannot read the settings row). */
  failing: [] as string[],
}));

vi.mock('@/lib/supabase/server', () => ({
  serviceClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      state.svc.push({ fn, args });
      return fn === 'cache_purge_take'
        ? { data: state.take, error: null }
        : { data: null, error: null };
    },
    from: (table: string) => ({
      select: () => ({
        eq: (_column: string, tenant: string) => ({
          maybeSingle: async () => {
            state.reads.push(`${table}:${tenant}`);
            if (state.failing.includes(table)) return { data: null, error: { message: 'down' } };
            return { data: state.rows[table] ?? null, error: null };
          },
        }),
      }),
    }),
  }),
}));
vi.mock('@/lib/data/systemLog', () => ({
  writeSystemLog: async (entry: Record<string, unknown>) => {
    state.logs.push(entry);
    return true;
  },
}));
vi.mock('@/lib/admin/redirectSync', () => ({
  syncRedirectsOfTenant: async (_sb: unknown, tenantId: string) => {
    state.syncs.push(`redirects:${tenantId}`);
    return { kvSynced: true, count: 1, truncated: false };
  },
}));
vi.mock('@/lib/admin/visibilitySync', () => ({
  rebuildVisibilitySnapshot: async (_sb: unknown, tenantId: string) => {
    state.syncs.push(`visibility:${tenantId}`);
    return { snapshot: {}, kvSynced: true };
  },
}));

const { afterPublish, rebuildSnapshots, snapshotNeeds } =
  await import('@/lib/release/afterEffects');
const { resetPurgeBreaker, COLLAPSE_TAG } = await import('@/lib/http/purge');
const { MAINTENANCE_KV_KEY } = await import('@/lib/http/maintenance');
const { __kv } = (await import('cloudflare:workers')) as unknown as { __kv: Map<string, string> };

type Item = ApplyResult['items'][number];
const T = '00000000-0000-4000-8000-0000000000b1';
const RELEASE = '0e0e0e0e-0000-4000-8000-000000000001';
const PAGE = '0f0f0f0f-0000-4000-8000-000000000005';
const AUTH = {
  userId: '11111111-1111-4111-8111-111111111111',
  tenantId: T,
  role: 'content_creator',
  isActive: true,
} as unknown as AuthContext;

const item = (type: string, op: Item['op'], before: unknown, after: unknown): Item =>
  ({
    id: 1,
    tenant_id: T,
    release_id: RELEASE,
    entity_type: type,
    entity_id: PAGE,
    op,
    before,
    after,
    draft_id: null,
    actor_id: null,
    created_at: '2026-10-22T10:00:00+00:00',
  }) as Item;

/** The publisher's client: the batched slug read and the audit insert, recorded. */
function publisher() {
  const calls: string[] = [];
  const audits: Record<string, unknown>[] = [];
  const sb = {
    rpc: async (fn: string, args: { p_reads: { table: string; ids: string[] }[] }) => {
      calls.push(`rpc:${fn}`);
      return {
        data: args.p_reads.map((r) => r.ids.map((id) => ({ id, slug: 'about' }))),
        error: null,
      };
    },
    from: (table: string) => ({
      insert: async (row: Record<string, unknown>) => {
        calls.push(`insert:${table}`);
        audits.push(row);
        return { error: null };
      },
    }),
  };
  return { sb: sb as never, calls, audits };
}

const zone = (...answers: Response[]) => ({
  config: { zoneId: '0123456789abcdef0123456789abcdef', token: 'purge-token' },
  fetchImpl: (async () => {
    const next = answers.shift();
    if (!next) throw new Error('unexpected fetch');
    return next;
  }) as unknown as typeof fetch,
  sleep: async () => undefined,
  random: () => 0.5,
});
const record = () => state.svc.find((c) => c.fn === 'record_release_purge')!.args;

beforeEach(() => {
  state.svc = [];
  state.take = true;
  state.logs = [];
  state.syncs = [];
  state.rows = {};
  state.reads = [];
  state.failing = [];
  __kv.delete(MAINTENANCE_KV_KEY);
  resetPurgeBreaker();
});

describe('the snapshots a release moves', () => {
  it('a redirect, a visibility row, a page renamed or removed; never a title edit or a new page', () => {
    expect(snapshotNeeds([item('redirect', 'create', null, {})])).toEqual({
      redirects: true,
      visibility: false,
    });
    expect(snapshotNeeds([item('page_visibility', 'update', {}, {})]).visibility).toBe(true);
    expect(
      snapshotNeeds([item('page', 'update', { slug: 'about' }, { slug: 'who' })]).visibility,
    ).toBe(true);
    expect(snapshotNeeds([item('page', 'delete', { slug: 'about' }, null)]).visibility).toBe(true);
    expect(
      snapshotNeeds([item('page', 'update', { slug: 'about' }, { slug: 'about' })]).visibility,
    ).toBe(false);
    expect(snapshotNeeds([item('page', 'create', null, { slug: 'new' })]).visibility).toBe(false);
    expect(snapshotNeeds(null)).toEqual({
      redirects: true,
      visibility: true,
      maintenance: { row: null },
    });
  });
});

describe("the maintenance page's contact buttons after a release (R14-prep, R7's hand-off)", () => {
  const BRAND = { en: 'Studio', ar: 'استوديو' };
  const identity = (over: Record<string, unknown> = {}) => ({
    tenant_id: T,
    brand_name: BRAND,
    contact_email: 'hello@studio.example',
    whatsapp_e164: '+966500000000',
    tagline: { en: 'Old', ar: 'قديم' },
    ...over,
  });
  const ON = { active: true, allowlist: [], changedAt: '2026-10-28T08:00:00.000Z' };
  const edgeContact = () =>
    (JSON.parse(__kv.get(MAINTENANCE_KV_KEY) ?? 'null') as { contact?: Record<string, unknown> })
      ?.contact;
  const needs = (row: Record<string, unknown> | null) => ({
    redirects: false,
    visibility: false,
    maintenance: { row },
  });

  it('owed only when the release moved the brand, the e-mail or the WhatsApp number', () => {
    const moved = identity({ contact_email: 'new@studio.example' });
    expect(snapshotNeeds([item('site_profile', 'update', identity(), moved)])).toEqual(
      needs(moved),
    );
    expect(
      snapshotNeeds([
        item('site_profile', 'update', identity(), identity({ brand_name: { en: 'S', ar: 'س' } })),
      ]).maintenance,
    ).toBeDefined();
    // The tagline, or a key order the database wrote differently, is not the buttons' business.
    expect(
      snapshotNeeds([
        item(
          'site_profile',
          'update',
          identity(),
          identity({ tagline: { en: 'New', ar: 'جديد' } }),
        ),
      ]).maintenance,
    ).toBeUndefined();
    expect(
      snapshotNeeds([
        item(
          'site_profile',
          'update',
          identity(),
          identity({ brand_name: { ar: BRAND.ar, en: BRAND.en } }),
        ),
      ]).maintenance,
    ).toBeUndefined();
    // Another type's contact-looking columns are not the identity.
    expect(
      snapshotNeeds([item('team_member', 'update', {}, { contact_email: 'x@studio.example' })])
        .maintenance,
    ).toBeUndefined();
  });

  it('maintenance on: the edge carries the settings row with the buttons from the release', async () => {
    __kv.set(
      MAINTENANCE_KV_KEY,
      JSON.stringify({
        ...ON,
        contact: { brand: BRAND, email: 'old@studio.example', whatsappE164: null },
      }),
    );
    state.rows['site_settings'] = { maintenance: ON };
    const moved = identity({ contact_email: 'new@studio.example' });
    // Refreshed, and not the edge rules' business: no `kvSynced` (review C4).
    expect(await rebuildSnapshots(T, needs(moved))).toBeUndefined();
    // The settings row read as the system, for this tenant; the identity taken from the image.
    expect(state.reads).toEqual([`site_settings:${T}`]);
    expect(edgeContact()).toEqual({
      brand: BRAND,
      email: 'new@studio.example',
      whatsappE164: '+966500000000',
    });
  });

  it('items not known: the identity is read as the system', async () => {
    __kv.set(MAINTENANCE_KV_KEY, JSON.stringify(ON));
    state.rows['site_settings'] = { maintenance: ON };
    state.rows['site_profile'] = identity({ contact_email: 'read@studio.example' });
    await rebuildSnapshots(T, needs(null));
    expect(state.reads).toEqual([`site_settings:${T}`, `site_profile:${T}`]);
    expect(edgeContact()).toMatchObject({ email: 'read@studio.example' });
  });

  it('a refresh that missed is logged, never reported as the edge rules missing (review C4)', async () => {
    // The publish dialog reads `kvSynced: false` as "the redirect and page visibility rules did
    // not reach the edge; use Sync to edge", which is untrue here and fixes nothing.
    const edge = JSON.stringify(ON);
    __kv.set(MAINTENANCE_KV_KEY, edge);
    // The settings row cannot be read: the buttons are not put.
    state.failing = ['site_settings'];
    expect(await rebuildSnapshots(T, needs(identity()))).toBeUndefined();
    expect(__kv.get(MAINTENANCE_KV_KEY)).toBe(edge);
    expect(state.logs).toEqual([
      expect.objectContaining({ level: 'warn', source: 'release:snapshot' }),
    ]);
    // With the redirect map rebuilt as well, the answer is the map's alone.
    expect(await rebuildSnapshots(T, { ...needs(identity()), redirects: true })).toBe(true);
  });

  it('maintenance off at the edge: nothing read, nothing written, nothing owed', async () => {
    state.rows['site_settings'] = { maintenance: ON };
    expect(await rebuildSnapshots(T, needs(identity()))).toBeUndefined();
    expect(state.reads).toEqual([]);
    expect(__kv.has(MAINTENANCE_KV_KEY)).toBe(false);
  });

  it('the edge on but the settings row off: never switched on, never rewritten', async () => {
    const edge = JSON.stringify(ON);
    __kv.set(MAINTENANCE_KV_KEY, edge);
    state.rows['site_settings'] = { maintenance: { active: false } };
    expect(await rebuildSnapshots(T, needs(identity()))).toBeUndefined();
    expect(__kv.get(MAINTENANCE_KV_KEY)).toBe(edge);
  });

  it('a publish that changed the identity refreshes the buttons; one that did not reads nothing', async () => {
    __kv.set(MAINTENANCE_KV_KEY, JSON.stringify(ON));
    state.rows['site_settings'] = { maintenance: ON };
    const { sb } = publisher();
    await afterPublish({
      sb,
      auth: AUTH,
      releaseId: RELEASE,
      number: 14,
      items: [
        item('site_profile', 'update', identity(), identity({ whatsapp_e164: '+966511111111' })),
      ],
    });
    expect(edgeContact()).toMatchObject({ whatsappE164: '+966511111111' });
    state.reads = [];
    await afterPublish({
      sb,
      auth: AUTH,
      releaseId: RELEASE,
      number: 15,
      items: [item('statistic', 'update', {}, {})],
    });
    expect(state.reads).toEqual([]);
  });
});

describe('after a publish, a cache zone set up', () => {
  it('purged: recorded done with its tags, and a release.purge row as the publisher', async () => {
    const { sb, calls, audits } = publisher();
    const result = await afterPublish({
      sb,
      auth: AUTH,
      releaseId: RELEASE,
      number: 12,
      items: [item('page_section', 'update', { page_id: PAGE }, { page_id: PAGE })],
      purge: zone(new Response(JSON.stringify({ success: true }))),
    });
    expect(result).toEqual({ purge: 'done', tags: ['page:about'] });
    // The page's slug read in one request, as the publisher.
    expect(calls).toEqual(['rpc:release_read_rows', 'insert:audit_log']);
    expect(record()).toMatchObject({
      p_tenant: T,
      p_release: RELEASE,
      p_status: 'done',
      p_tags: ['page:about'],
      p_next_at: null,
    });
    expect(audits).toEqual([
      expect.objectContaining({
        tenant_id: T,
        actor_id: AUTH.userId,
        action: 'release.purge',
        entity_type: 'release',
        entity_id: RELEASE,
        detail: { number: 12, status: 'done', tags: 1 },
      }),
    ]);
    expect(state.logs).toEqual([]);
  });

  it('refused (a 429): recorded failed with the cron’s next try in about a minute, a warning, and its row', async () => {
    const { sb, audits } = publisher();
    const before = Date.now();
    const result = await afterPublish({
      sb,
      auth: AUTH,
      releaseId: RELEASE,
      number: 13,
      items: [item('statistic', 'update', {}, {})],
      purge: zone(new Response('', { status: 429 })),
    });
    expect(result.purge).toBe('failed');
    const next = Date.parse(String(record()['p_next_at'])) - before;
    expect(next).toBeGreaterThanOrEqual(25_000);
    expect(next).toBeLessThanOrEqual(61_000);
    expect(record()['p_tags']).toEqual(['statistics:all']);
    expect(state.logs).toEqual([
      expect.objectContaining({ level: 'warn', source: 'release:purge' }),
    ]);
    expect(audits[0]).toMatchObject({
      action: 'release.purge',
      detail: { number: 13, status: 'failed', tags: 1, reason: 'rate-limited' },
    });
  });

  it('nothing sent (over the day’s budget): failed and retried later, but no release.purge row', async () => {
    state.take = false;
    const { sb, audits } = publisher();
    const result = await afterPublish({
      sb,
      auth: AUTH,
      releaseId: RELEASE,
      number: 14,
      items: [item('faq_item', 'update', {}, {})],
      purge: zone(),
    });
    expect(result.purge).toBe('failed');
    expect(record()['p_next_at']).not.toBeNull();
    expect(audits).toEqual([]);
  });

  it('items unknown (an apply that landed after the wait): both snapshots, the whole site', async () => {
    const { sb, calls } = publisher();
    const result = await afterPublish({
      sb,
      auth: AUTH,
      releaseId: RELEASE,
      number: 15,
      items: null,
      purge: zone(new Response(JSON.stringify({ success: true }))),
    });
    expect(state.syncs).toEqual([`redirects:${T}`, `visibility:${T}`]);
    expect(result).toEqual({ purge: 'done', kvSynced: true, tags: [COLLAPSE_TAG] });
    expect(calls).toEqual(['insert:audit_log']);
  });

  it('a redirect alone: the map rebuilt as the system, nothing to purge, nothing sent or audited', async () => {
    const { sb, audits } = publisher();
    const result = await afterPublish({
      sb,
      auth: AUTH,
      releaseId: RELEASE,
      number: 16,
      items: [item('redirect', 'create', null, { source_path: '/a', target_path: '/b' })],
      purge: zone(),
    });
    expect(result).toEqual({ purge: 'not_needed', kvSynced: true, tags: [] });
    expect(record()).toMatchObject({ p_status: 'not_needed', p_tags: [] });
    expect(state.svc.some((c) => c.fn === 'cache_purge_take')).toBe(false);
    expect(audits).toEqual([]);
  });
});
