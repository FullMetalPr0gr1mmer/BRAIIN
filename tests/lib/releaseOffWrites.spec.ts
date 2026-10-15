import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { APIRoute } from 'astro';
import { RESOURCES } from '@/lib/admin/resources';
import {
  SAMPLE,
  SAMPLE_NOW,
  SAMPLE_OVERRIDES,
  sampleOf,
  samplesFor,
} from '../fixtures/resourceSamples';

// With releases off, every save writes exactly what it wrote before Admin v2 R2.
//
// R2 gives each release-managed config a `fields` map (payload key → the columns it can
// emit) and moves the two singleton configs and the entity-SEO mapping out of their route
// files. It deliberately does NOT rebuild `toRow` (R2 brief, decision D1), so the legacy
// write path must be unchanged byte for byte. The snapshot beside this file was recorded
// from main 23ce829, before any of that moved: every resource config's `toRow` over the
// full sample, each key alone, and each key cleared (null), errors included; and the
// values the site-profile, SEO-defaults and entity-SEO routes hand to the database on a
// first save (an INSERT) and on an edit (an UPDATE), driven through the real routes.
// The order of the keys each write sends is recorded too, as arrays (snapshots print
// object keys sorted); that part was recorded from 23ce829's sources as well.

vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = '11111111-1111-4111-8111-111111111111';

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(SAMPLE_NOW);
});
afterAll(() => {
  vi.useRealTimers();
});

type Out = Record<string, unknown> | { error: string };

function run(fn: () => Record<string, unknown>): Out {
  try {
    return fn();
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

const KEYS = [
  ...new Set([...Object.keys(SAMPLE), ...Object.values(SAMPLE_OVERRIDES).flatMap(Object.keys)]),
].sort();

/** What one `toRow` writes: the full sample, then each key alone and each key cleared. */
function record(
  entity: string,
  toRow: (input: Record<string, unknown>) => Record<string, unknown>,
) {
  const keys: Record<string, Out> = {};
  const nulls: Record<string, Out> = {};
  for (const key of KEYS) {
    const one = run(() => toRow({ [key]: sampleOf(entity, key) }));
    if (Object.keys(one).length > 0) keys[key] = one;
    const cleared = run(() => toRow({ [key]: null }));
    if (Object.keys(cleared).length > 0) nulls[key] = cleared;
  }
  return { full: run(() => toRow(samplesFor(entity))), keys, nulls };
}

/** The key order of every output `record` captured (snapshots sort object keys). */
function keyOrder(recorded: ReturnType<typeof record>) {
  const order = (out: Out) => Object.keys(out);
  const each = (map: Record<string, Out>) =>
    Object.fromEntries(Object.entries(map).map(([key, out]) => [key, order(out)]));
  return { full: order(recorded.full), keys: each(recorded.keys), nulls: each(recorded.nulls) };
}

describe('resource configs: toRow is what it was before R2', () => {
  for (const [slug, config] of Object.entries(RESOURCES).sort(([a], [b]) => a.localeCompare(b))) {
    it(slug, () => {
      const recorded = record(config.entity, config.toRow);
      expect(recorded).toMatchSnapshot();
      // The snapshot prints object keys sorted, so the order a write sends them in is held
      // apart, as arrays (R2 review L5).
      expect(keyOrder(recorded)).toMatchSnapshot();
    });
  }
});

// ---- the routes that are not resource configs -----------------------------------------------

interface Write {
  table: string;
  op: 'insert' | 'update';
  values: unknown;
}

/** A client over one tenant: `existing` is the stored row (null = none yet). */
function client(existing: Record<string, unknown> | null, writes: Write[]) {
  return {
    from: (table: string) => {
      let wrote = false;
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'order', 'limit', 'neq']) b[m] = () => b;
      b['insert'] = (values: unknown) => {
        writes.push({ table, op: 'insert', values });
        wrote = true;
        return b;
      };
      b['update'] = (values: unknown) => {
        writes.push({ table, op: 'update', values });
        wrote = true;
        return b;
      };
      b['maybeSingle'] = async () => ({
        data: wrote ? { ...(existing ?? {}), version: 9 } : existing,
        error: null,
      });
      b['single'] = async () => ({ data: { version: 1 }, error: null });
      return b;
    },
  };
}

function call(method: 'PATCH' | 'PUT', url: string, body: unknown, sb: unknown) {
  const full = new URL(url, 'https://admin.example.test');
  return {
    request: new Request(full, {
      method,
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
    url: full,
    params: {},
    locals: {
      session: { userId: USER, tenantId: TENANT, role: 'admin', isActive: true, email: 'a@x.test' },
      supabase: sb,
      cspNonce: 'test',
      csrfToken: 'test',
    },
  } as unknown as Parameters<APIRoute>[0];
}

const pickKeys = (entity: string, keys: readonly string[]) =>
  Object.fromEntries(keys.map((key) => [key, sampleOf(entity, key)]));

const ROUTES: {
  name: string;
  url: string;
  method: 'PATCH' | 'PUT';
  body: Record<string, unknown>;
  stored: Record<string, unknown>;
  load: () => Promise<Record<string, unknown>>;
}[] = [
  {
    name: 'site profile',
    url: '/api/admin/site-profile',
    method: 'PATCH',
    body: pickKeys('site_profile', [
      'brandName',
      'legalName',
      'contactEmail',
      'whatsappE164',
      'whatsappDisplay',
      'location',
      'addressLocality',
      'addressCountry',
      'foundedYear',
      'socials',
      'acceptingApplications',
    ]),
    stored: { version: 3, accepting_applications: false },
    load: () => import('@/pages/api/admin/site-profile'),
  },
  {
    name: 'SEO defaults',
    url: '/api/admin/seo-defaults',
    method: 'PATCH',
    body: pickKeys('seo_defaults', [
      'titleTemplate',
      'defaultTitle',
      'defaultDescription',
      'defaultOgImage',
      'organization',
      'robotsDirectives',
    ]),
    stored: { version: 3 },
    load: () => import('@/pages/api/admin/seo-defaults'),
  },
  {
    name: 'entity SEO',
    url: '/api/admin/entity-seo',
    method: 'PUT',
    body: pickKeys('entity_seo', [
      'entityType',
      'entityId',
      'metaTitle',
      'metaDescription',
      'ogImage',
      'canonicalOverride',
      'robots',
      'schemaType',
    ]),
    stored: { id: '22222222-2222-4222-8222-222222222222', version: 3 },
    load: () => import('@/pages/api/admin/entity-seo'),
  },
];

describe('singleton and entity-SEO routes: the database receives what it did before R2', () => {
  for (const route of ROUTES) {
    it(`${route.name}: the first save (an INSERT)`, async () => {
      const handler = (await route.load())[route.method] as APIRoute;
      const writes: Write[] = [];
      const res = (await handler(
        call(route.method, route.url, { ...route.body, version: 0 }, client(null, writes)),
      )) as Response;
      expect(res.status, await res.clone().text()).toBe(200);
      expect(writes).toMatchSnapshot();
      expect(writes.map((w) => Object.keys(w.values as object))).toMatchSnapshot();
    });

    it(`${route.name}: an edit (an UPDATE)`, async () => {
      const handler = (await route.load())[route.method] as APIRoute;
      const writes: Write[] = [];
      const res = (await handler(
        call(route.method, route.url, { ...route.body, version: 3 }, client(route.stored, writes)),
      )) as Response;
      expect(res.status, await res.clone().text()).toBe(200);
      expect(writes).toMatchSnapshot();
      expect(writes.map((w) => Object.keys(w.values as object))).toMatchSnapshot();
    });

    it(`${route.name}: a partial edit`, async () => {
      if (route.method === 'PUT') return; // entity SEO is a full replace (PUT)
      const handler = (await route.load())[route.method] as APIRoute;
      const writes: Write[] = [];
      const [first] = Object.keys(route.body);
      const body = { [first!]: route.body[first!], version: 3 };
      const res = (await handler(
        call(route.method, route.url, body, client(route.stored, writes)),
      )) as Response;
      expect(res.status, await res.clone().text()).toBe(200);
      expect(writes).toMatchSnapshot();
      expect(writes.map((w) => Object.keys(w.values as object))).toMatchSnapshot();
    });
  }
});
