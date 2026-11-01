import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIRoute } from 'astro';
import { RELEASE_ENTITY_TYPES, type AsOfAnswer } from '@schemas/release';
import type { Role } from '@/lib/auth/types';
import { client, resetIds, T, type Db, type Row } from '../fixtures/stagedDb';
import {
  ADMIN,
  OTHER_USER,
  auditRowsOf,
  callRoute,
  draftRow,
  liveWritesOf,
  makeDb,
} from '../fixtures/stagedRoute';

// Versions, history and restore (Admin v2 R10) over the PostgREST stand-in: the versions list
// and one version's changes (per area), restoring a version (the whole site or one page) as
// pending changes through the draft writer and the restore's mark, what a restore refuses
// (a pending change, a change the person cannot publish, an image today's schema refuses, a
// link to something gone, an address another item holds, too many), an entity's numbered
// history and its restore, and the rollback publish. The state at a version is SQL (0104,
// pgTAP release_versions): here `release_as_of` is a scripted answer, and the request it gets
// is asserted. Releases off (every tenant until R14): nothing is staged and nothing changes.

const svc = vi.hoisted(() => ({
  db: null as unknown as Db,
  calls: [] as { fn: string; args: Record<string, unknown> }[],
  logs: [] as Record<string, unknown>[],
  /** content_drafts writes by the service role (the restore's mark). */
  marks: [] as Record<string, unknown>[],
  failMark: false,
  /** Runs just before the mark: a co-author's save landing between the write and the mark. */
  beforeMark: null as (() => void) | null,
}));

vi.mock('@/lib/supabase/server', () => ({
  serviceClient: () => ({
    from: (table: string) => {
      const q = client(svc.db).from(table) as Record<string, (...a: unknown[]) => unknown>;
      if (table !== 'content_drafts') return q;
      const update = q['update']!;
      return {
        ...q,
        update: (values: Record<string, unknown>) => {
          svc.marks.push(values);
          svc.beforeMark?.();
          if (svc.failMark) {
            return {
              eq: () => ({
                in: () => ({
                  eq: () => ({
                    is: () => ({
                      select: async () => ({ data: null, error: { message: 'dropped' } }),
                    }),
                  }),
                }),
              }),
            };
          }
          return update(values);
        },
      };
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      svc.calls.push({ fn, args });
      if (fn === 'apply_release') {
        return { data: { release_id: id(99), number: 4, items: [] }, error: null };
      }
      return { data: null, error: null };
    },
  }),
}));
vi.mock('@/lib/data/systemLog', () => ({
  writeSystemLog: async (entry: Record<string, unknown>) => {
    svc.logs.push(entry);
    return true;
  },
}));

const { GET: LIST, POST: PUBLISH } = await import('@/pages/api/admin/releases/index');
const { GET: DETAIL } = await import('@/pages/api/admin/releases/[id]');
const { POST: RESTORE } = await import('@/pages/api/admin/releases/[id]/restore');
const { GET: HISTORY } = await import('@/pages/api/admin/history/index');
const { POST: HISTORY_RESTORE } = await import('@/pages/api/admin/history/restore');
const { RESTORE_COPY } = await import('@/lib/release/restore');
const { RELEASE_REGISTRY } = await import('@/lib/release/registry');
const { derivePatch } = await import('@/lib/release/overlay');
const { fullPayload, SAMPLE_LINKED_IDS } = await import('../fixtures/restoreImages');
const { ROLLBACK_COPY } = await import('@/lib/release/endpoints');

const BI = (en: string, ar: string) => ({ en, ar });
const id = (n: number) => `0e0e0e0e-0000-4000-8000-${String(n).padStart(12, '0')}`;
const V1 = id(901);
const V2 = id(902);
const V3 = id(903);
const SERVICE = id(1);
const SERVICE_2 = id(2);
const DISCIPLINE = id(3);
const POSTER = id(4);
const PROJECT = id(5);
const PAGE = id(6);
const SECTION = id(7);
const THEME = id(8);
const STAT = id(9);
const OTHER_PROJECT = id(10);
/** The page the samples' visibility setting names. */
const PAGE_A = '0f0f0f0f-0000-4000-8000-00000000000a';

const release = (over: Row): Row => ({
  tenant_id: T,
  kind: 'publish',
  status: 'published',
  note: null,
  scheduled_for: null,
  scheduled_by: null,
  published_at: '2026-10-01T09:00:00+00:00',
  published_by: ADMIN,
  restores_release_id: null,
  item_count: 1,
  areas: ['content'],
  purge_status: 'skipped',
  failure: null,
  payload: null,
  version: 1,
  created_at: '2026-10-01T09:00:00+00:00',
  ...over,
});

const liveService = (over: Row = {}): Row => ({
  id: SERVICE,
  tenant_id: T,
  slug: 'logo',
  title: BI('Logo Design', 'تصميم الشعار'),
  status: 'published',
  discipline_id: DISCIPLINE,
  poster_media_id: POSTER,
  version: 3,
  ...over,
});

/** The ledger's answer for version `number`. */
function asOf(number: number, entities: AsOfAnswer['entities'], total?: number): AsOfAnswer {
  return {
    release: {
      id: [V1, V2, V3][number - 1] ?? V1,
      number,
      kind: 'publish',
      note: null,
      published_at: '2026-10-01T09:00:00+00:00',
      published_by: ADMIN,
    },
    cutoff: 5,
    total: total ?? entities.length,
    entities,
  };
}

function seed(tables: Record<string, Row[]> = {}, answer?: AsOfAnswer | null): Db {
  const db = makeDb({
    profiles: [{ id: ADMIN, tenant_id: T, role: 'admin', is_active: true, locked_until: null }],
    staff_directory: [{ id: ADMIN, display_name: 'Amal', role: 'admin' }],
    content_releases: [
      release({ id: V1, number: 1, kind: 'baseline' }),
      release({ id: V2, number: 2 }),
      release({
        id: V3,
        number: 3,
        kind: 'rollback',
        restores_release_id: V1,
        note: 'Restored v1',
      }),
    ],
    services: [liveService()],
    disciplines: [
      { id: DISCIPLINE, tenant_id: T, slug: 'branding', status: 'published', version: 1 },
    ],
    media_assets: [{ id: POSTER, tenant_id: T, kind: 'image' }],
    portfolio: [],
    portfolio_services: [],
    portfolio_media: [],
    pages: [],
    page_sections: [],
    custom_themes: [],
    statistics: [],
    site_profile: [],
    content_versions: [],
    ...tables,
  });
  db.rpc = (fn, args) => {
    if (fn !== 'release_as_of') return undefined;
    if (answer === undefined || answer === null || args['p_tenant'] !== T) {
      return { data: null, error: { code: 'P0002', message: 'no such version' } };
    }
    return { data: structuredClone(answer), error: null };
  };
  svc.db = db;
  return db;
}

async function as(
  role: Role,
  db: Db,
  route: APIRoute,
  method: string,
  path: string,
  body?: unknown,
  params: Record<string, string> = {},
) {
  db.tables['profiles'] = [{ id: ADMIN, tenant_id: T, role, is_active: true, locked_until: null }];
  return callRoute(db, route, method, path, {
    role,
    params,
    ...(body === undefined ? {} : { body }),
  });
}

const restore = (db: Db, version = V1, body: unknown = {}, role: Role = 'admin') =>
  as(role, db, RESTORE, 'POST', `/api/admin/releases/${version}/restore`, body, { id: version });

const writerCalls = (db: Db) => db.calls.filter((c) => c.name === 'write_drafts');
const asOfCalls = (db: Db) => db.calls.filter((c) => c.name === 'release_as_of');

beforeEach(() => {
  resetIds();
  svc.calls = [];
  svc.logs = [];
  svc.marks = [];
  svc.failMark = false;
  svc.beforeMark = null;
});

// ---- the versions --------------------------------------------------------------------------

describe('GET /api/admin/releases: the versions', () => {
  it('newest first, the live one marked, a rollback naming what it restored, names from the directory', async () => {
    const db = seed({
      content_releases: [
        release({ id: V1, number: 1, kind: 'baseline' }),
        release({ id: V2, number: 2 }),
        release({ id: V3, number: 3, kind: 'rollback', restores_release_id: V1 }),
        release({
          id: id(904),
          number: null,
          status: 'scheduled',
          scheduled_for: '2026-11-01T09:00:00+00:00',
          scheduled_by: ADMIN,
          payload: [{ secret: true }],
        }),
        release({
          id: id(905),
          number: null,
          status: 'failed',
          failure: { code: 'conflict', message: 'the database said something private' },
        }),
      ],
    });
    const res = await as('content_creator', db, LIST, 'GET', '/api/admin/releases');
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ enabled: true, live: 3, more: false });
    const versions = res.data['versions'] as Row[];
    expect(versions.map((v) => v['number'])).toEqual([3, 2, 1]);
    expect(versions[0]).toMatchObject({
      kind: 'rollback',
      restores: 1,
      live: true,
      publishedBy: { id: ADMIN, name: 'Amal' },
    });
    expect(versions[1]).toMatchObject({ live: false, restores: null });
    const upcoming = res.data['upcoming'] as Row[];
    expect(upcoming.map((v) => v['status']).sort()).toEqual(['failed', 'scheduled']);
    expect(upcoming.find((v) => v['status'] === 'failed')).toMatchObject({ failure: 'conflict' });
    // A frozen payload and a failure's words never leave the database.
    expect(JSON.stringify(res.body)).not.toContain('secret');
    expect(JSON.stringify(res.body)).not.toContain('private');
  });

  it('pages back with ?before=N; only the first page names the live version', async () => {
    const db = seed();
    const res = await as('seo', db, LIST, 'GET', '/api/admin/releases?before=3');
    expect((res.data['versions'] as Row[]).map((v) => v['number'])).toEqual([2, 1]);
    expect(res.data['live']).toBe(null);
    expect(res.data['upcoming']).toEqual([]);
  });

  it('releases off: no version exists, the list is empty and says so', async () => {
    const db = seed({ content_releases: [] });
    db.flag = false;
    const res = await as('developer', db, LIST, 'GET', '/api/admin/releases');
    expect(res.data).toMatchObject({ enabled: false, live: null, versions: [], upcoming: [] });
  });

  it('a malformed ?before is 422', async () => {
    const res = await as('admin', seed(), LIST, 'GET', '/api/admin/releases?before=0');
    expect(res.status).toBe(422);
  });
});

describe('GET /api/admin/releases/[id]: one version’s changes', () => {
  const items = (): Row[] => [
    {
      id: 1,
      tenant_id: T,
      release_id: V2,
      entity_type: 'service',
      entity_id: SERVICE,
      op: 'update',
      draft_id: id(50),
      before: {
        title: BI('Logo', 'شعار'),
        sort_order: 1,
        body: { en: { type: 'doc' } },
        updated_at: 'x',
        version: 2,
        search_en: 'x',
      },
      after: {
        title: BI('Logo Design', 'تصميم الشعار'),
        sort_order: 2,
        body: { en: { type: 'doc', content: [] } },
        updated_at: 'y',
        version: 3,
        search_en: 'y',
      },
    },
    {
      id: 2,
      tenant_id: T,
      release_id: V2,
      entity_type: 'testimonial',
      entity_id: id(60),
      op: 'update',
      draft_id: id(51),
      before: { author_name: 'Sam', consent_reference: 'ref-1' },
      after: { author_name: 'Sam', consent_reference: 'ref-2' },
    },
    {
      id: 3,
      tenant_id: T,
      release_id: V2,
      entity_type: 'portfolio_children',
      entity_id: PROJECT,
      op: 'update',
      draft_id: null,
      before: { service_ids: [SERVICE], media: [] },
      after: { service_ids: [], media: [] },
    },
    {
      id: 4,
      tenant_id: T,
      release_id: V2,
      entity_type: 'page',
      entity_id: PAGE,
      op: 'create',
      draft_id: id(52),
      before: null,
      after: { slug: 'about-us', title: BI('About', 'من نحن'), status: 'draft' },
    },
    {
      id: 5,
      tenant_id: T,
      release_id: V1,
      entity_type: 'service',
      entity_id: SERVICE_2,
      op: 'delete',
      draft_id: id(53),
      before: { slug: 'gone' },
      after: null,
    },
  ];

  it('plain and bilingual fields before and after; rich text, sets and consent only as changed', async () => {
    const db = seed({ content_release_items: items() });
    const res = await as('admin', db, DETAIL, 'GET', `/api/admin/releases/${V2}`, undefined, {
      id: V2,
    });
    expect(res.status).toBe(200);
    expect(res.data['release']).toMatchObject({ id: V2, number: 2 });
    const shown = res.data['items'] as Row[];
    expect(shown.map((i) => i['entityType'])).toEqual([
      'service',
      'testimonial',
      'portfolio_children',
      'page',
    ]);
    expect(shown[0]).toMatchObject({
      area: 'services',
      label: { en: 'Logo Design' },
      cascade: false,
      fields: [
        { column: 'body', kind: 'changed' },
        { column: 'sort_order', kind: 'text', before: 1, after: 2 },
        {
          column: 'title',
          kind: 'bilingual',
          before: BI('Logo', 'شعار'),
          after: BI('Logo Design', 'تصميم الشعار'),
        },
      ],
    });
    expect(shown[1]!['fields']).toEqual([{ column: 'consent_reference', kind: 'changed' }]);
    expect(JSON.stringify(shown[1])).not.toContain('ref-2');
    expect(shown[2]).toMatchObject({
      cascade: true,
      label: null,
      fields: [{ column: 'service_ids', kind: 'changed' }],
    });
    expect(res.data).toMatchObject({ hidden: 0, truncated: false });
  });

  it('a change in an area the person does not read is counted, never listed (Developer)', async () => {
    const db = seed({ content_release_items: items() });
    const res = await as('developer', db, DETAIL, 'GET', `/api/admin/releases/${V2}`, undefined, {
      id: V2,
    });
    expect((res.data['items'] as Row[]).map((i) => i['entityType'])).toEqual(['page']);
    expect(res.data['hidden']).toBe(3);
    expect(JSON.stringify(res.body)).not.toContain('Logo');
  });

  it('a rollback names the number of the version it restored, read apart (not in this read)', async () => {
    const db = seed();
    const res = await as('admin', db, DETAIL, 'GET', `/api/admin/releases/${V3}`, undefined, {
      id: V3,
    });
    expect(res.status).toBe(200);
    expect(res.data['release']).toMatchObject({ id: V3, kind: 'rollback', restores: 1 });
  });

  it('a version that is not there, or not an id, is 404', async () => {
    const db = seed();
    for (const v of [id(999), 'nope']) {
      const res = await as('admin', db, DETAIL, 'GET', `/api/admin/releases/${v}`, undefined, {
        id: v,
      });
      expect(res.status).toBe(404);
    }
  });
});

// ---- restoring a version -------------------------------------------------------------------

/** The brand's own theme settings (Admin v2 E4), which compile to no token. */
const BRAND_THEME = {
  v: 1,
  mode: 'simple',
  colors: { primary: '#0024BC', hover: '#024CFF', accent: '#22A9FF' },
  motion: { marquee: 'normal', reveal: true },
};

describe('POST /api/admin/releases/[id]/restore', () => {
  it('releases off: 409 releases-off after the flag read, and nothing else read or written', async () => {
    const db = seed({}, asOf(1, []));
    db.flag = false;
    const res = await restore(db);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'releases-off', detail: RESTORE_COPY.off });
    expect(db.calls.filter((c) => c.kind === 'from')).toEqual([]);
    expect(asOfCalls(db)).toEqual([]);
  });

  it('a version that is not there is 404; one not published is 422', async () => {
    let res = await restore(seed({}, asOf(1, [])), id(999));
    expect(res.status).toBe(404);
    const db = seed({
      content_releases: [
        release({
          id: id(904),
          number: null,
          status: 'scheduled',
          scheduled_for: 'x',
          scheduled_by: ADMIN,
        }),
      ],
    });
    res = await restore(db, id(904));
    expect(res.status).toBe(422);
    expect(res.body['detail']).toBe(RESTORE_COPY.notVersion);
  });

  it('stages the state at the version as pending changes, marked as its restore; live is untouched', async () => {
    const db = seed(
      {
        // Created since v1: goes. Removed since: comes back with its link sets.
        statistics: [{ id: STAT, tenant_id: T, slug: 'years', status: 'published', version: 1 }],
        services: [liveService({ title: BI('Logo Design v2', 'تصميم الشعار ٢') })],
      },
      asOf(1, [
        {
          entity_type: 'service',
          entity_id: SERVICE,
          before: { ...liveService(), title: BI('Logo Design', 'تصميم الشعار') },
          exists_now: true,
        },
        { entity_type: 'statistic', entity_id: STAT, before: null, exists_now: true },
        {
          entity_type: 'portfolio',
          entity_id: PROJECT,
          before: {
            id: PROJECT,
            slug: 'spring',
            title: BI('Spring', 'الربيع'),
            status: 'draft',
            sort_order: 1,
          },
          exists_now: false,
        },
        {
          entity_type: 'portfolio_children',
          entity_id: PROJECT,
          before: {
            service_ids: [SERVICE],
            media: [{ role: 'hero', kind: 'image', media_id: POSTER, caption: null }],
          },
          exists_now: true,
        },
        // Never in a version (O-12): ignored even if the ledger named one.
        { entity_type: 'team_member', entity_id: id(70), before: { slug: 'x' }, exists_now: true },
      ]),
    );
    const res = await restore(db);
    expect(res.status).toBe(200);
    expect(asOfCalls(db)[0]!.values).toEqual({
      p_tenant: T,
      p_number: 1,
      p_limit: 200,
      p_page: null,
    });
    // One writer call, under the person's own client.
    const [call] = writerCalls(db);
    const ops = (call!.values as Row)['p_ops'] as Row[];
    const byType = Object.fromEntries(ops.map((o) => [o['entity_type'], o]));
    expect(byType['service']).toMatchObject({
      op: 'update',
      entity_id: SERVICE,
      payload: { title: BI('Logo Design', 'تصميم الشعار') },
      base: { title: BI('Logo Design v2', 'تصميم الشعار ٢') },
      base_version: 3,
    });
    expect(byType['statistic']).toMatchObject({ op: 'delete', entity_id: STAT, payload: {} });
    expect(byType['portfolio']).toMatchObject({
      op: 'create',
      entity_id: PROJECT,
      base_version: null,
      payload: {
        slug: 'spring',
        serviceIds: [SERVICE],
        media: [{ role: 'hero', kind: 'image', mediaId: POSTER }],
      },
    });
    expect(ops).toHaveLength(3);
    // The mark: the service role, every new change at its first version, as V1's restore.
    expect(svc.marks).toEqual([{ origin_kind: 'restore', origin_release_id: V1 }]);
    const drafts = db.tables['content_drafts']!;
    expect(drafts.every((d) => d['origin_kind'] === 'restore' && d['version'] === 2)).toBe(true);
    expect(res.data).toMatchObject({ release: { id: V1, number: 1 }, scope: 'site', marked: true });
    expect((res.data['staged'] as Row[]).map((s) => s['draftVersion'])).toEqual([2, 2, 2]);
    // Nothing live was written; the audit row has types and counts, never a value.
    for (const table of ['services', 'statistics', 'portfolio']) {
      expect(liveWritesOf(db, table)).toEqual([]);
    }
    const audit = auditRowsOf(db).find((r) => r['action'] === 'versions.restore');
    expect(audit).toMatchObject({
      entity_type: 'release',
      entity_id: V1,
      detail: { number: 1, scope: 'site', count: 3, types: ['portfolio', 'service', 'statistic'] },
    });
    expect(JSON.stringify(audit)).not.toContain('Logo');
  });

  it('a column already as the version had it is no change; nothing to stage writes nothing', async () => {
    const db = seed(
      {},
      asOf(1, [
        { entity_type: 'service', entity_id: SERVICE, before: liveService(), exists_now: true },
      ]),
    );
    const res = await restore(db);
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ staged: [], marked: true });
    expect(writerCalls(db)).toEqual([]);
    expect(auditRowsOf(db)).toEqual([]);
  });

  it('a derived column today renders differently is no change on its own (body_html)', async () => {
    const body = {
      en: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }],
      },
    };
    // The body is as it was; its cached HTML is not what today's renderer makes of it.
    const live = liveService({ body, body_html: { en: '<p>rendered by an older build</p>' } });
    const db = seed(
      { services: [live] },
      asOf(1, [
        {
          entity_type: 'service',
          entity_id: SERVICE,
          before: { ...live, body_html: { en: '<p>Hi, as it was cached then</p>' } },
          exists_now: true,
        },
      ]),
    );
    const res = await restore(db);
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ staged: [], marked: true });
    expect(writerCalls(db)).toEqual([]);
  });

  it('one page: the ledger is asked for that page, the audit says so', async () => {
    const db = seed(
      {
        pages: [
          {
            id: PAGE,
            tenant_id: T,
            slug: 'about',
            title: BI('About', 'من نحن'),
            status: 'published',
            nav_visible: true,
            version: 2,
          },
        ],
      },
      asOf(1, [
        {
          entity_type: 'page',
          entity_id: PAGE,
          before: {
            slug: 'about',
            title: BI('About us', 'عنا'),
            status: 'published',
            nav_visible: true,
          },
          exists_now: true,
          page_id: null,
        },
      ]),
    );
    const res = await restore(db, V1, { pageId: PAGE }, 'content_creator');
    expect(res.status).toBe(200);
    expect(asOfCalls(db)[0]!.values).toMatchObject({ p_page: PAGE });
    expect(res.data).toMatchObject({ scope: 'page' });
    expect(auditRowsOf(db)[0]).toMatchObject({ detail: { scope: 'page', pageId: PAGE, count: 1 } });
  });

  it('an entity with a pending change stops the whole restore: 409 naming it, nothing written', async () => {
    const db = seed(
      { content_drafts: [draftRow({ id: id(80), entity_type: 'service', entity_id: SERVICE })] },
      asOf(1, [
        {
          entity_type: 'service',
          entity_id: SERVICE,
          before: liveService({ title: BI('Old', 'قديم') }),
          exists_now: true,
        },
      ]),
    );
    const res = await restore(db);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: 'pending-changes',
      items: [{ entityType: 'service', entityId: SERVICE, reason: 'pending' }],
    });
    expect(writerCalls(db)).toEqual([]);
  });

  it('a change the person cannot publish stops it: 403 with who could (the cross-area restore)', async () => {
    // A v1 theme (Admin v2 E4): its settings, and the tokens they compile to (none for the
    // brand's own). A legacy theme's version (no settings) cannot come back: its tokens have
    // no field since E4.
    const theme = {
      id: THEME,
      tenant_id: T,
      name: 'Night',
      settings: BRAND_THEME,
      tokens: {},
      is_active: true,
      version: 2,
    };
    const db = seed(
      { custom_themes: [theme] },
      asOf(1, [
        {
          entity_type: 'service',
          entity_id: SERVICE,
          before: liveService({ title: BI('Old', 'قديم') }),
          exists_now: true,
        },
        {
          entity_type: 'custom_theme',
          entity_id: THEME,
          before: { ...theme, name: 'Day' },
          exists_now: true,
        },
      ]),
    );
    const res = await restore(db, V1, {}, 'content_creator');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      error: 'forbidden',
      detail: RESTORE_COPY.forbidden,
      items: [
        { entityType: 'custom_theme', reason: 'forbidden', waitingFor: ['admin', 'developer'] },
      ],
    });
    // Content Creator does not read themes: the item is named by its type, never its words.
    expect((res.body['items'] as Row[])[0]!['label']).toBe(null);
    expect(writerCalls(db)).toEqual([]);
  });

  it('a legacy theme (no settings, before E4) cannot come back: its tokens have no field now', async () => {
    const legacy = {
      id: THEME,
      tenant_id: T,
      name: 'Night',
      tokens: { '--bs-klein': '#000000' },
      is_active: false,
      version: 2,
    };
    const db = seed(
      { custom_themes: [legacy] },
      asOf(1, [
        {
          entity_type: 'custom_theme',
          entity_id: THEME,
          before: { ...legacy, name: 'Day' },
          exists_now: true,
        },
      ]),
    );
    const res = await restore(db, V1, {}, 'admin');
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      error: 'not-restorable',
      items: [{ entityType: 'custom_theme', reason: 'unrestorable', columns: ['tokens'] }],
    });
    expect(writerCalls(db)).toEqual([]);
  });

  it('a refusal names every refused item under every reason at once, grouped; the status is the first reason', async () => {
    // A v1 theme (Admin v2 E4): its settings, and the tokens they compile to (none for the
    // brand's own). A legacy theme's version (no settings) cannot come back: its tokens have
    // no field since E4.
    const theme = {
      id: THEME,
      tenant_id: T,
      name: 'Night',
      settings: BRAND_THEME,
      tokens: {},
      is_active: true,
      version: 2,
    };
    const db = seed(
      {
        custom_themes: [theme],
        services: [
          liveService(),
          liveService({ id: SERVICE_2, slug: 'web', poster_media_id: null }),
        ],
        content_drafts: [draftRow({ id: id(80), entity_type: 'service', entity_id: SERVICE })],
      },
      asOf(1, [
        // A pending change on it.
        {
          entity_type: 'service',
          entity_id: SERVICE,
          before: liveService({ title: BI('Old', 'قديم') }),
          exists_now: true,
        },
        // Not the Content Creator's to publish.
        {
          entity_type: 'custom_theme',
          entity_id: THEME,
          before: { ...theme, name: 'Day' },
          exists_now: true,
        },
        // A picture that is gone now.
        {
          entity_type: 'service',
          entity_id: SERVICE_2,
          before: liveService({ id: SERVICE_2, slug: 'web', poster_media_id: id(44) }),
          exists_now: true,
        },
      ]),
    );
    const res = await restore(db, V1, {}, 'content_creator');
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'pending-changes', detail: RESTORE_COPY.pending });
    expect((res.body['items'] as Row[]).map((r) => `${r['entityId']} ${r['reason']}`)).toEqual([
      `${SERVICE} pending`,
      `${THEME} forbidden`,
      `${SERVICE_2} link-gone`,
    ]);
    expect(
      (res.body['groups'] as Row[]).map((g) => [g['error'], (g['items'] as Row[]).length]),
    ).toEqual([
      ['pending-changes', 1],
      ['forbidden', 1],
      ['not-restorable', 1],
    ]);
    expect(writerCalls(db)).toEqual([]);
  });

  it('a removal only an Admin publishes: a Content Creator is refused it', async () => {
    const db = seed(
      { statistics: [{ id: STAT, tenant_id: T, slug: 'years', status: 'published', version: 1 }] },
      asOf(1, [{ entity_type: 'statistic', entity_id: STAT, before: null, exists_now: true }]),
    );
    const res = await restore(db, V1, {}, 'content_creator');
    expect(res.status).toBe(403);
    expect(res.body['items']).toMatchObject([{ entityType: 'statistic', waitingFor: ['admin'] }]);
  });

  it('an edit that leaves an archived row archived is an Admin’s (hotfix H12)', async () => {
    const archived = liveService({ status: 'archived', title: BI('Now', 'الآن') });
    const answer = asOf(1, [
      {
        entity_type: 'service',
        entity_id: SERVICE,
        before: { ...archived, title: BI('Then', 'سابقا') },
        exists_now: true,
      },
    ]);
    let res = await restore(seed({ services: [archived] }, answer), V1, {}, 'content_creator');
    expect(res.status).toBe(403);
    expect(res.body['items']).toMatchObject([{ entityType: 'service', waitingFor: ['admin'] }]);
    res = await restore(seed({ services: [archived] }, answer), V1, {}, 'admin');
    expect(res.status).toBe(200);
  });

  it('a link to something gone and not brought back is 422 naming the field (a deleted picture)', async () => {
    const db = seed(
      { media_assets: [] },
      asOf(1, [
        {
          entity_type: 'service',
          entity_id: SERVICE,
          before: liveService({ title: BI('Old', 'قديم'), poster_media_id: id(44) }),
          exists_now: true,
        },
      ]),
    );
    const res = await restore(db);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      error: 'not-restorable',
      items: [
        { entityType: 'service', entityId: SERVICE, reason: 'link-gone', field: 'posterMediaId' },
      ],
    });
    expect(writerCalls(db)).toEqual([]);
  });

  it('a quote removed since is 422 on consent for a Content Creator: never re-created with its old consent', async () => {
    const QUOTE = id(61);
    const db = seed(
      { testimonials: [] },
      asOf(1, [
        {
          entity_type: 'testimonial',
          entity_id: QUOTE,
          before: {
            id: QUOTE,
            slug: 'rana',
            quote: BI('It was great', 'كان رائعا'),
            author_name: BI('Rana', 'رنا'),
            placements: [],
            consent_obtained_at: '2026-09-01T00:00:00+00:00',
            consent_reference: 'email 2026-09-01',
            is_placeholder: false,
            status: 'published',
            sort_order: 1,
          },
          exists_now: false,
        },
      ]),
    );
    const res = await restore(db, V1, {}, 'content_creator');
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      error: 'not-restorable',
      items: [{ entityType: 'testimonial', entityId: QUOTE, reason: 'consent' }],
    });
    expect(writerCalls(db)).toEqual([]);
    expect(JSON.stringify(res.body)).not.toContain('email 2026-09-01');
  });

  it('a link to a row the same restore brings back passes', async () => {
    const db = seed(
      { disciplines: [] },
      asOf(1, [
        {
          entity_type: 'service',
          entity_id: SERVICE,
          before: liveService({ title: BI('Old', 'قديم') }),
          exists_now: true,
        },
        {
          entity_type: 'discipline',
          entity_id: DISCIPLINE,
          before: {
            id: DISCIPLINE,
            slug: 'branding',
            name: BI('Branding', 'الهوية'),
            status: 'published',
            sort_order: 1,
          },
          exists_now: false,
        },
      ]),
    );
    // The live service still names the discipline (the stand-in has no foreign keys); the
    // restored image does too, and the discipline comes back in the same restore.
    const res = await restore(db);
    expect(res.status).toBe(200);
    expect((res.data['staged'] as Row[]).map((s) => s['op']).sort()).toEqual(['create', 'update']);
  });

  it('an address another item now holds is 422 (edge case 5), unless the restore moves that item too', async () => {
    const other = {
      id: OTHER_PROJECT,
      tenant_id: T,
      slug: 'spring',
      title: BI('Other', 'آخر'),
      status: 'published',
      version: 1,
    };
    const back = {
      entity_type: 'portfolio',
      entity_id: PROJECT,
      before: { id: PROJECT, slug: 'spring', title: BI('Spring', 'الربيع'), status: 'draft' },
      exists_now: false,
    };
    let res = await restore(seed({ portfolio: [other] }, asOf(1, [back])));
    expect(res.status).toBe(422);
    expect(res.body['items']).toMatchObject([
      { entityId: PROJECT, reason: 'address-taken', field: 'slug' },
    ]);
    // The holder renamed back by the same restore: the dry run orders it, the restore stages it.
    res = await restore(
      seed(
        { portfolio: [other] },
        asOf(1, [
          back,
          {
            entity_type: 'portfolio',
            entity_id: OTHER_PROJECT,
            before: { ...other, slug: 'autumn' },
            exists_now: true,
          },
        ]),
      ),
    );
    expect(res.status).toBe(200);
  });

  it("an image today's schema refuses is 422, never staged as something the version did not hold", async () => {
    const db = seed(
      {},
      asOf(1, [
        {
          entity_type: 'service',
          entity_id: SERVICE,
          before: liveService({ slug: 'Not A Slug' }),
          exists_now: true,
        },
      ]),
    );
    const res = await restore(db);
    expect(res.status).toBe(422);
    expect(res.body['items']).toMatchObject([{ entityType: 'service', reason: 'unrestorable' }]);
  });

  it('the identity created since stays (no release removes it); a visibility setting made since goes back to public', async () => {
    const visibility = {
      id: id(30),
      tenant_id: T,
      page_id: PAGE,
      template: null,
      mode: 'hidden',
      redirect_page_id: null,
      hide_from: null,
      show_on: null,
      note: null,
      version: 1,
    };
    const db = seed(
      {
        site_profile: [{ tenant_id: T, brand_name: BI('Studio', 'استوديو'), version: 1 }],
        page_visibility: [visibility],
        pages: [{ id: PAGE, tenant_id: T, slug: 'about', status: 'published', version: 1 }],
      },
      asOf(1, [
        { entity_type: 'site_profile', entity_id: T, before: null, exists_now: true },
        { entity_type: 'page_visibility', entity_id: id(30), before: null, exists_now: true },
      ]),
    );
    const res = await restore(db, V1, {}, 'developer');
    expect(res.status).toBe(200);
    expect(res.data['kept']).toMatchObject([{ entityType: 'site_profile', reason: 'kept' }]);
    // The audit row says one item was left as it is (a count, never what it was).
    expect(auditRowsOf(db).find((r) => r['action'] === 'versions.restore')).toMatchObject({
      detail: { count: 1, kept: 1, types: ['page_visibility'] },
    });
    const [call] = writerCalls(db);
    expect((call!.values as Row)['p_ops']).toMatchObject([
      {
        entity_type: 'page_visibility',
        op: 'update',
        payload: { mode: 'public' },
        fields: ['mode'],
      },
    ]);
  });

  it('more than one release carries is 422 too-many; a version too far back is refused before planning', async () => {
    const stats = Array.from({ length: 61 }, (_, i) => ({
      id: id(1000 + i),
      tenant_id: T,
      slug: `s${i}`,
      status: 'published',
      version: 1,
    }));
    let res = await restore(
      seed(
        { statistics: stats },
        asOf(
          1,
          stats.map((s) => ({
            entity_type: 'statistic',
            entity_id: s.id,
            before: null,
            exists_now: true,
          })),
        ),
      ),
    );
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: 'too-many', count: 61 });
    const db = seed({}, asOf(1, [], 201));
    res = await restore(db);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: 'too-many', count: 201 });
    expect(db.calls.filter((c) => c.name === 'services')).toEqual([]);
  });

  it('a demoted person is refused before anything is staged (the live re-read)', async () => {
    const db = seed(
      {},
      asOf(1, [
        {
          entity_type: 'service',
          entity_id: SERVICE,
          before: liveService({ title: BI('Old', 'قديم') }),
          exists_now: true,
        },
      ]),
    );
    db.tables['profiles'] = [
      { id: ADMIN, tenant_id: T, role: 'seo', is_active: true, locked_until: null },
    ];
    const res = await callRoute(db, RESTORE, 'POST', `/api/admin/releases/${V1}/restore`, {
      body: {},
      params: { id: V1 },
    });
    expect(res.status).toBe(403);
    expect(writerCalls(db)).toEqual([]);
  });

  it('the mark never lands on a change a co-author saved after the restore wrote it', async () => {
    const db = seed(
      {},
      asOf(1, [
        {
          entity_type: 'service',
          entity_id: SERVICE,
          before: liveService({ title: BI('Old', 'قديم') }),
          exists_now: true,
        },
      ]),
    );
    // Between the restore's write (version 1) and its mark, a colleague saves the change (2).
    svc.beforeMark = () => {
      for (const d of db.tables['content_drafts']!) {
        Object.assign(d, { version: 2, updated_by: OTHER_USER, payload: { title: BI('X', 'س') } });
      }
    };
    const res = await restore(db);
    expect(res.status).toBe(200);
    expect(res.data['marked']).toBe(false);
    const [draft] = db.tables['content_drafts']!;
    expect(draft).toMatchObject({ version: 2, origin_kind: null, updated_by: OTHER_USER });
    expect(svc.logs).toContainEqual(expect.objectContaining({ source: 'release:restore' }));
  });

  it('a mark that does not land leaves ordinary pending changes: logged, never a failed restore', async () => {
    svc.failMark = true;
    const db = seed(
      {},
      asOf(1, [
        {
          entity_type: 'service',
          entity_id: SERVICE,
          before: liveService({ title: BI('Old', 'قديم') }),
          exists_now: true,
        },
      ]),
    );
    const res = await restore(db);
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ marked: false, staged: [{ draftVersion: 1 }] });
    expect(svc.logs).toContainEqual(
      expect.objectContaining({ level: 'warn', source: 'release:restore' }),
    );
  });
});

// ---- one entity's history ------------------------------------------------------------------

describe('GET /api/admin/history', () => {
  const versions = (): Row[] =>
    [1, 2, 3].map((seq) => ({
      id: id(100 + seq),
      tenant_id: T,
      entity_type: 'service',
      entity_id: SERVICE,
      seq,
      version: seq === 3 ? 1 : seq,
      created_at: `2026-10-0${seq}T09:00:00+00:00`,
      created_by: ADMIN,
      release_id: seq === 1 ? null : seq === 2 ? V2 : V3,
      snapshot: liveService({ title: BI(`Title ${seq}`, `عنوان ${seq}`) }),
    }));

  it('its numbered snapshots newest first, the version that made each, live now, its pending change', async () => {
    const db = seed({
      content_versions: versions(),
      content_drafts: [
        draftRow({ id: id(80), entity_type: 'service', entity_id: SERVICE, fields: ['title'] }),
      ],
    });
    const res = await as(
      'seo',
      db,
      HISTORY,
      'GET',
      `/api/admin/history?entityType=service&entityId=${SERVICE}`,
    );
    expect(res.status).toBe(200);
    expect(
      (res.data['versions'] as Row[]).map((v) => [
        v['seq'],
        v['version'],
        (v['release'] as Row | null)?.['number'] ?? null,
        v['live'],
      ]),
    ).toEqual([
      [3, 1, 3, true],
      [2, 2, 2, false],
      [1, 1, null, false],
    ]);
    expect(res.data).toMatchObject({
      live: true,
      removed: null,
      // SEO reads services but publishes none.
      restorable: false,
      pending: { draftId: id(80), fields: ['title'], by: { id: ADMIN, name: 'Amal' } },
    });
    // A snapshot's content is never in the list (Preview and Restore fetch what they need).
    expect(JSON.stringify(res.body)).not.toContain('Title 2');
  });

  it('a removed entity says which version removed it', async () => {
    const db = seed({
      services: [],
      content_versions: versions(),
      content_release_items: [
        {
          id: 7,
          tenant_id: T,
          release_id: V3,
          entity_type: 'service',
          entity_id: SERVICE,
          op: 'delete',
          before: {},
          after: null,
          created_at: '2026-10-03T09:00:00+00:00',
        },
      ],
    });
    const res = await as(
      'content_creator',
      db,
      HISTORY,
      'GET',
      `/api/admin/history?entityType=service&entityId=${SERVICE}`,
    );
    expect(res.data).toMatchObject({
      live: false,
      restorable: true,
      removed: { release: { id: V3, number: 3 } },
    });
    expect((res.data['versions'] as Row[])[0]!['live']).toBe(false);
  });

  it("a page's history: every version that changed it or one of its sections", async () => {
    const db = seed({
      content_release_items: [
        {
          id: 1,
          tenant_id: T,
          release_id: V1,
          entity_type: 'page',
          entity_id: PAGE,
          op: 'create',
          before: null,
          after: {},
        },
        {
          id: 2,
          tenant_id: T,
          release_id: V3,
          entity_type: 'page_section',
          entity_id: SECTION,
          op: 'update',
          before: { page_id: PAGE },
          after: { page_id: PAGE },
        },
        {
          id: 3,
          tenant_id: T,
          release_id: null,
          entity_type: 'page_section',
          entity_id: SECTION,
          op: 'update',
          before: { page_id: PAGE },
          after: { page_id: PAGE },
        },
        {
          id: 4,
          tenant_id: T,
          release_id: V2,
          entity_type: 'page_section',
          entity_id: id(77),
          op: 'update',
          before: { page_id: id(78) },
          after: { page_id: id(78) },
        },
      ],
    });
    const res = await as(
      'developer',
      db,
      HISTORY,
      'GET',
      `/api/admin/history?entityType=page&entityId=${PAGE}&scope=page`,
    );
    expect(res.status).toBe(200);
    expect((res.data['versions'] as Row[]).map((v) => v['number'])).toEqual([3, 1]);
    // A release that never went live (failed) changed nothing: it is no version of the page.
    db.tables['content_releases']!.push(
      release({ id: id(905), number: null, status: 'failed', published_at: null }),
    );
    db.tables['content_release_items']!.push({
      id: 5,
      tenant_id: T,
      release_id: id(905),
      entity_type: 'page',
      entity_id: PAGE,
      op: 'update',
      before: {},
      after: {},
    });
    const again = await as(
      'developer',
      db,
      HISTORY,
      'GET',
      `/api/admin/history?entityType=page&entityId=${PAGE}&scope=page`,
    );
    expect((again.data['versions'] as Row[]).map((v) => v['id'])).toEqual([V3, V1]);
    // Developer reads pages (maintenance.manage) but publishes none.
    expect(res.data['restorable']).toBe(false);
  });

  it('an area the person does not read is 403 (Developer and a service); a page scope on anything else is 422', async () => {
    let res = await as(
      'developer',
      seed(),
      HISTORY,
      'GET',
      `/api/admin/history?entityType=service&entityId=${SERVICE}`,
    );
    expect(res.status).toBe(403);
    res = await as(
      'admin',
      seed(),
      HISTORY,
      'GET',
      `/api/admin/history?entityType=service&entityId=${SERVICE}&scope=page`,
    );
    expect(res.status).toBe(422);
  });
});

describe("the site's own settings and a page's search settings (R14-prep)", () => {
  const OTHER_T = '00000000-0000-4000-8000-0000000000ff';
  const singleton = (type: string, tenant: string, seq: number, releaseId: string | null): Row => ({
    id: id(400 + seq),
    tenant_id: tenant,
    entity_type: type,
    entity_id: tenant,
    seq,
    version: seq,
    created_at: `2026-10-0${seq}T09:00:00+00:00`,
    created_by: ADMIN,
    release_id: releaseId,
    snapshot: { tenant_id: tenant, version: seq },
  });

  it('the identity and the SEO defaults name no id: the history is the session tenant’s', async () => {
    const db = seed({
      site_profile: [{ tenant_id: T, version: 2, brand_name: BI('Studio', 'استوديو') }],
      seo_defaults: [{ tenant_id: T, version: 1 }],
      content_versions: [
        singleton('site_profile', T, 1, null),
        singleton('site_profile', T, 2, V2),
        // Another site's row never answers, and a row of this site keyed by anything but the
        // site is not the identity's (the read is keyed by the session's tenant).
        singleton('site_profile', OTHER_T, 3, null),
        { ...singleton('site_profile', T, 5, null), entity_id: OTHER_T },
        singleton('seo_defaults', T, 4, null),
      ],
    });
    const res = await as(
      'developer',
      db,
      HISTORY,
      'GET',
      '/api/admin/history?entityType=site_profile',
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.data).toMatchObject({
      entity: { entityType: 'site_profile', entityId: T },
      live: true,
      // Releases on in this stand-in, but Developer publishes the identity (settings.general).
      restorable: true,
    });
    expect((res.data['versions'] as Row[]).map((v) => [v['seq'], v['live']])).toEqual([
      [2, true],
      [1, false],
    ]);

    const seo = await as('seo', db, HISTORY, 'GET', '/api/admin/history?entityType=seo_defaults');
    expect(seo.status).toBe(200);
    expect((seo.data['versions'] as Row[]).map((v) => v['seq'])).toEqual([4]);
  });

  it('a singleton naming an id, or an item naming none, is refused before any read (422)', async () => {
    const db = seed();
    let res = await as(
      'admin',
      db,
      HISTORY,
      'GET',
      `/api/admin/history?entityType=site_profile&entityId=${OTHER_T}`,
    );
    expect(res.status).toBe(422);
    res = await as('admin', db, HISTORY, 'GET', '/api/admin/history?entityType=service');
    expect(res.status).toBe(422);
    res = await as('admin', db, HISTORY_RESTORE, 'POST', '/api/admin/history/restore', {
      entityType: 'seo_defaults',
      entityId: OTHER_T,
      seq: 1,
    });
    expect(res.status).toBe(422);
    expect(db.calls.filter((c) => c.name === 'content_versions')).toEqual([]);
  });

  it("the identity's history is its area's: Content Creator (no settings.general) is 403", async () => {
    const res = await as(
      'content_creator',
      seed(),
      HISTORY,
      'GET',
      '/api/admin/history?entityType=site_profile',
    );
    expect(res.status).toBe(403);
  });

  it('restoring a version of the identity reads the session tenant’s snapshot', async () => {
    const db = seed({
      site_profile: [{ tenant_id: T, version: 2, brand_name: BI('Studio', 'استوديو') }],
      content_versions: [
        {
          ...singleton('site_profile', T, 1, V2),
          snapshot: { tenant_id: T, version: 1, brand_name: BI('Old', 'قديم') },
        },
      ],
    });
    const res = await as('admin', db, HISTORY_RESTORE, 'POST', '/api/admin/history/restore', {
      entityType: 'site_profile',
      seq: 1,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(auditRowsOf(db)).toMatchObject([
      { action: 'site_profile.history_restore', entity_id: T, detail: { seq: 1 } },
    ]);
  });

  it("a page's search settings are read by the row's own id (entity SEO)", async () => {
    const SEO_ROW = id(450);
    const db = seed({
      entity_seo: [
        { id: SEO_ROW, tenant_id: T, entity_type: 'service', entity_id: SERVICE, version: 1 },
      ],
      content_versions: [
        {
          ...singleton('entity_seo', T, 1, null),
          entity_id: SEO_ROW,
        },
      ],
    });
    const res = await as(
      'content_creator',
      db,
      HISTORY,
      'GET',
      `/api/admin/history?entityType=entity_seo&entityId=${SEO_ROW}`,
    );
    // Content Creator holds seo.entityMeta at view: it reads the history, restores none.
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ live: true, restorable: false });
    expect((res.data['versions'] as Row[]).map((v) => v['seq'])).toEqual([1]);
  });
});

describe('POST /api/admin/history/restore', () => {
  const snapshot = (seq: number, row: Row, releaseId: string | null = V2): Row => ({
    id: id(100 + seq),
    tenant_id: T,
    entity_type: 'service',
    entity_id: SERVICE,
    seq,
    version: seq,
    created_at: '2026-10-02T09:00:00+00:00',
    created_by: ADMIN,
    release_id: releaseId,
    snapshot: row,
  });

  const body = (seq = 2) => ({ entityType: 'service', entityId: SERVICE, seq });

  it('one snapshot staged as the change back to it, marked a restore of no version; audited by number', async () => {
    const db = seed({
      content_versions: [
        snapshot(2, { ...liveService(), title: BI('Earlier', 'سابق'), search_en: 'x' }),
      ],
    });
    const res = await as(
      'content_creator',
      db,
      HISTORY_RESTORE,
      'POST',
      '/api/admin/history/restore',
      body(),
    );
    expect(res.status).toBe(200);
    const [call] = writerCalls(db);
    expect((call!.values as Row)['p_ops']).toMatchObject([
      {
        op: 'update',
        entity_id: SERVICE,
        payload: { title: BI('Earlier', 'سابق') },
        base_version: 3,
      },
    ]);
    expect(svc.marks).toEqual([{ origin_kind: 'restore', origin_release_id: null }]);
    expect(res.data).toMatchObject({ release: { id: V2, number: 2 }, scope: 'item', marked: true });
    expect(auditRowsOf(db)).toMatchObject([
      {
        action: 'service.history_restore',
        entity_id: SERVICE,
        detail: { seq: 2, number: 2, op: 'update' },
      },
    ]);
  });

  it('the snapshot of a removed entity brings it back with its own id', async () => {
    const db = seed({ services: [], content_versions: [snapshot(2, liveService(), null)] });
    const res = await as(
      'admin',
      db,
      HISTORY_RESTORE,
      'POST',
      '/api/admin/history/restore',
      body(),
    );
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({
      release: null,
      staged: [{ op: 'create', entityId: SERVICE }],
    });
  });

  it('refusals: no such snapshot 404; a team member 422; SEO (reads, cannot publish) 403; Developer 403; releases off 409', async () => {
    let res = await as(
      'admin',
      seed(),
      HISTORY_RESTORE,
      'POST',
      '/api/admin/history/restore',
      body(9),
    );
    expect(res.status).toBe(404);
    res = await as('admin', seed(), HISTORY_RESTORE, 'POST', '/api/admin/history/restore', {
      ...body(),
      entityType: 'team_member',
    });
    expect(res.status).toBe(422);
    expect(res.body['detail']).toBe(RESTORE_COPY.noHistory);
    const db = seed({
      content_versions: [snapshot(2, { ...liveService(), title: BI('Earlier', 'سابق') })],
    });
    res = await as('seo', db, HISTORY_RESTORE, 'POST', '/api/admin/history/restore', body());
    expect(res.status).toBe(403);
    res = await as('developer', db, HISTORY_RESTORE, 'POST', '/api/admin/history/restore', body());
    expect(res.status).toBe(403);
    const off = seed({ content_versions: [snapshot(2, liveService())] });
    off.flag = false;
    res = await as('admin', off, HISTORY_RESTORE, 'POST', '/api/admin/history/restore', body());
    expect(res.status).toBe(409);
    expect(writerCalls(db)).toEqual([]);
  });
});

// ---- the rollback --------------------------------------------------------------------------

describe('POST /api/admin/releases with kind rollback', () => {
  const restored = (over: Row = {}) =>
    draftRow({
      id: id(80),
      entity_type: 'service',
      entity_id: SERVICE,
      op: 'update',
      payload: { title: BI('Logo', 'شعار') },
      base: { title: BI('Logo Design', 'تصميم الشعار') },
      origin_kind: 'restore',
      origin_release_id: V1,
      // As the restore leaves it: its write (1), then the mark (2).
      version: 2,
      ...over,
    });
  const publishBody = (drafts: Row[], extra: Row = {}) => ({
    items: drafts.map((d) => ({ draftId: d['id'], draftVersion: d['version'] })),
    kind: 'rollback',
    ...extra,
  });
  const applyArgs = () => svc.calls.find((c) => c.fn === 'apply_release')?.args;

  it('publishes a restore’s changes as a rollback naming the version, "Restored vN" by default', async () => {
    const db = seed({ content_drafts: [restored()] });
    const res = await as(
      'content_creator',
      db,
      PUBLISH,
      'POST',
      '/api/admin/releases',
      publishBody([restored()]),
    );
    expect(res.status).toBe(200);
    expect(applyArgs()).toMatchObject({
      p_mode: 'publish',
      p_kind: 'rollback',
      p_restores_release_id: V1,
      p_note: 'Restored v1',
    });
  });

  it('a note given is kept', async () => {
    const db = seed({ content_drafts: [restored()] });
    await as(
      'admin',
      db,
      PUBLISH,
      'POST',
      '/api/admin/releases',
      publishBody([restored()], { note: 'Back to spring' }),
    );
    expect(applyArgs()).toMatchObject({ p_kind: 'rollback', p_note: 'Back to spring' });
  });

  it('a change no restore staged, or restores of two versions, are 422 on kind; nothing applied', async () => {
    for (const drafts of [
      [restored({ origin_kind: null, origin_release_id: null })],
      [restored(), restored({ id: id(81), entity_id: SERVICE_2, origin_release_id: V2 })],
    ]) {
      const db = seed({
        content_drafts: drafts,
        services: [liveService(), liveService({ id: SERVICE_2, slug: 'web' })],
      });
      const res = await as(
        'admin',
        db,
        PUBLISH,
        'POST',
        '/api/admin/releases',
        publishBody(drafts),
      );
      expect(res.status).toBe(422);
      expect(res.body['field']).toBe('kind');
    }
    expect(applyArgs()).toBeUndefined();
  });

  it('a restored change edited since the restore is 422 on kind: it no longer holds the version', async () => {
    const edited = restored({ version: 3 });
    const db = seed({ content_drafts: [edited] });
    const res = await as(
      'admin',
      db,
      PUBLISH,
      'POST',
      '/api/admin/releases',
      publishBody([edited]),
    );
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ field: 'kind', detail: ROLLBACK_COPY.edited });
    expect(applyArgs()).toBeUndefined();
  });

  it('a part of a version’s restore is 422 on kind; the whole of it publishes as the rollback', async () => {
    const other = restored({
      id: id(81),
      entity_id: SERVICE_2,
      payload: { title: BI('Web', 'ويب') },
    });
    const tables = {
      content_drafts: [restored(), other],
      services: [liveService(), liveService({ id: SERVICE_2, slug: 'web' })],
    };
    let db = seed(structuredClone(tables));
    let res = await as(
      'admin',
      db,
      PUBLISH,
      'POST',
      '/api/admin/releases',
      publishBody([restored()]),
    );
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ field: 'kind', detail: ROLLBACK_COPY.partial });
    expect(applyArgs()).toBeUndefined();
    // The same part, published as a plain release, is a publish.
    res = await as('admin', db, PUBLISH, 'POST', '/api/admin/releases', {
      ...publishBody([restored()]),
      kind: 'publish',
    });
    expect(res.status).toBe(200);
    expect(applyArgs()).toMatchObject({ p_kind: 'publish' });
    svc.calls = [];
    db = seed(structuredClone(tables));
    res = await as(
      'admin',
      db,
      PUBLISH,
      'POST',
      '/api/admin/releases',
      publishBody([restored(), other]),
    );
    expect(res.status).toBe(200);
    expect(applyArgs()).toMatchObject({ p_kind: 'rollback', p_restores_release_id: V1 });
  });

  it('a restore of a version that is no longer a published version is 422 on kind', async () => {
    const db = seed({ content_drafts: [restored({ origin_release_id: id(999) })] });
    const res = await as(
      'admin',
      db,
      PUBLISH,
      'POST',
      '/api/admin/releases',
      publishBody([restored({ origin_release_id: id(999) })]),
    );
    expect(res.status).toBe(422);
    expect(applyArgs()).toBeUndefined();
  });

  it('restored changes published as a plain publish are a publish', async () => {
    const db = seed({ content_drafts: [restored()] });
    await as('admin', db, PUBLISH, 'POST', '/api/admin/releases', {
      ...publishBody([restored()]),
      kind: 'publish',
    });
    expect(applyArgs()).toMatchObject({ p_kind: 'publish' });
    expect(applyArgs()?.['p_restores_release_id']).toBe(null);
  });
});

describe('the Free plan’s 50 subrequests (P-15)', () => {
  it('restoring 60 edits of one table costs a handful of reads, never one per change', async () => {
    const services = Array.from({ length: 60 }, (_, i) =>
      liveService({ id: id(3000 + i), slug: `s${i}`, title: BI(`Now ${i}`, `الآن ${i}`) }),
    );
    const db = seed(
      { services },
      asOf(
        1,
        services.map((s) => ({
          entity_type: 'service',
          entity_id: String(s['id']),
          before: { ...s, title: BI('Then', 'سابقا') },
          exists_now: true,
        })),
      ),
    );
    const res = await restore(db);
    expect(res.status).toBe(200);
    expect((res.data['staged'] as Row[]).length).toBe(60);
    // The person's client: the flag, the version, the ledger, the live rows, the pending
    // changes, the writer and the audit row; the service client: the re-read and the mark.
    expect(db.calls.map((c) => c.name).sort()).toEqual([
      'audit_log',
      'content_drafts',
      'content_drafts',
      'content_releases',
      'profiles',
      'release_as_of',
      'releases_enabled',
      'services',
      'write_drafts',
    ]);
  });

  it('restoring a version that changed every type, with links and addresses, stays inside 50 (tripwire)', async () => {
    // Every restorable type changed since v1, every column moved, each image linking to the
    // samples' rows (a picture, a discipline, a page …) and writing an address: the worst case
    // R6's all-types publish has too. The links of a table the restore reads anyway are asked
    // with its live rows; the rest cost one read per table.
    const tables: Record<string, Row[]> = {
      content_releases: [release({ id: V1, number: 1 })],
      profiles: [{ id: ADMIN, tenant_id: T, role: 'admin', is_active: true, locked_until: null }],
      staff_directory: [],
      portfolio_services: [],
      portfolio_media: [],
    };
    for (const table of [
      'media_assets',
      'disciplines',
      'sectors',
      'clients',
      'services',
      'portfolio',
      'pages',
      'categories',
      'team_members',
      'navigation',
    ]) {
      tables[table] = SAMPLE_LINKED_IDS.map((linked) => ({ id: linked, tenant_id: T }));
    }
    const entities: AsOfAnswer['entities'] = [];
    let n = 0;
    for (const type of RELEASE_ENTITY_TYPES) {
      if (type === 'team_member') continue;
      const entry = RELEASE_REGISTRY[type];
      n += 1;
      const entityId = entry.key === 'tenant_id' ? T : id(5000 + n);
      const live: Row = { tenant_id: T, version: 1 };
      if (entry.key === 'id') live['id'] = entityId;
      if (type === 'page_visibility') Object.assign(live, { page_id: PAGE_A, mode: 'public' });
      // A quote's consent is never restored (it stays as it is now): recorded now.
      if (type === 'testimonial') live['consent_obtained_at'] = '2026-09-01T00:00:00+00:00';
      (tables[entry.table] ??= []).push(live);
      const image = derivePatch(entry, 'create', fullPayload(type)).patch;
      entities.push({
        entity_type: type,
        entity_id: entityId,
        before: { ...image, ...(entry.key === 'id' ? { id: entityId } : {}), tenant_id: T },
        exists_now: true,
      });
    }
    const db = seed(tables, asOf(1, entities));
    const res = await restore(db);
    expect(res.status).toBe(200);
    expect((res.data['staged'] as Row[]).length).toBe(n);
    // In production the session's two (the user, the profile) come first.
    const SESSION = 2;
    expect(db.calls.length + SESSION).toBeLessThanOrEqual(50);
    // Pinned, so a new type, link or address shows here before it shows on the Free plan.
    // 44 since Admin v2 E8 added the forms config (one more singleton to read).
    expect(db.calls.length).toBe(44);
  });
});
