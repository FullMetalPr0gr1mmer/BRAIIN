import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIRoute } from 'astro';
import type { Role } from '@/lib/auth/types';

// Round 2 (0028) admin resources through the real kernel routes, against a stubbed
// client: disciplines and service cases, the service form's new fields, the pickers that
// hide archived rows without dropping a link, and the testimonial sample lock's refusal
// said in words an editor can act on.

vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));
vi.mock('@/lib/admin/audit', () => ({ writeAudit: async () => undefined }));

const { collectionRoutes, itemRoutes } = await import('@/lib/admin/resource');
const R = await import('@/lib/admin/resources');
const { RESOURCE_UI, relationParams } = await import('@/lib/admin/uiSchema');
const { formToPayload, rowToForm } = await import('@/lib/admin/formPayload');

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID = '11111111-1111-4111-8111-111111111111';
const LIVE_SVC = '22222222-2222-4222-8222-222222222222';
const ARCHIVED_SVC = '33333333-3333-4333-8333-333333333333';
const DISC = '44444444-4444-4444-8444-444444444444';
const t = (en: string) => ({ en, ar: `ع-${en}` });

let stored: Record<string, unknown> = {};
/** The error the next UPDATE/INSERT answers with (a trigger refusal, a unique key). */
let writeError: { code: string; message: string } | null = null;
let calls: { table: string; op: string; args: unknown[] }[] = [];
let rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
let written: Record<string, unknown> | null = null;
/** Tables where a lookup by id finds nothing in the caller's tenant (another tenant's id). */
let missing = new Set<string>();

function stubDb() {
  const make = (table: string) => {
    const b: Record<string, unknown> = {};
    let writing = false;
    for (const m of ['select', 'eq', 'neq', 'is', 'order', 'range', 'delete', 'ilike']) {
      b[m] = (...args: unknown[]) => {
        calls.push({ table, op: m, args });
        return b;
      };
    }
    for (const m of ['insert', 'update']) {
      b[m] = (values: Record<string, unknown>) => {
        writing = true;
        written = values;
        calls.push({ table, op: m, args: [values] });
        return b;
      };
    }
    const answer = () => {
      if (writing && writeError) return { data: null, error: writeError };
      if (!writing && missing.has(table)) return { data: null, error: null };
      return { data: { id: ID, version: 1, ...stored }, error: null };
    };
    b['single'] = async () => answer();
    b['maybeSingle'] = async () => answer();
    b['then'] = (ok: (v: unknown) => unknown) =>
      Promise.resolve({ data: [{ id: ID, version: 1 }], error: null, count: 1 }).then(ok);
    return b;
  };
  return {
    from: (table: string) => make(table),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return { data: [{ id: ID, version: 2 }], error: null };
    },
  };
}

function ctx(role: Role, method: string, body?: unknown, query = '') {
  const url = new URL(`https://admin.example.test/api/admin/x/${ID}${query}`);
  return {
    request: new Request(url, {
      method,
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    }),
    url,
    params: { id: ID },
    locals: {
      session: { userId: ID, tenantId: TENANT, role, isActive: true, email: 'x@example.test' },
      supabase: stubDb(),
      cspNonce: 'n',
      csrfToken: 'c',
    },
  } as unknown as Parameters<APIRoute>[0];
}

async function call(route: APIRoute, c: Parameters<APIRoute>[0]) {
  const res = (await route(c)) as Response;
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  stored = {};
  writeError = null;
  calls = [];
  rpcCalls = [];
  written = null;
  missing = new Set();
});

describe('pickers hide archived rows — and never drop a link', () => {
  it('relationParams: equality as column=value, "is not" as column.neq=value', () => {
    expect(
      relationParams(
        { resource: 'x', labelKey: 'name', filter: { location: 'header' } },
        100,
      ).toString(),
    ).toBe('limit=100&location=header');
    expect(
      relationParams(
        { resource: 'services', labelKey: 'title', filter: { status: { neq: 'archived' } } },
        100,
      ).toString(),
    ).toBe('limit=100&status.neq=archived');
  });

  it("the case study's services picker (and the case editor's) hide archived services", () => {
    const serviceIds = RESOURCE_UI['portfolio']!.fields.find((f) => f.name === 'serviceIds')!;
    expect(serviceIds.relation?.filter).toEqual({ status: { neq: 'archived' } });
    const serviceId = RESOURCE_UI['service-cases']!.fields.find((f) => f.name === 'serviceId')!;
    expect(serviceId.relation?.filter).toEqual({ status: { neq: 'archived' } });
  });

  it('every relation filter names a column its list endpoint filters on (never a silent no-op)', () => {
    // Every resource a relation may point at, from the registry; the ones the pickers
    // filter today are pinned, so a registry that lost one fails here.
    const CONFIG: Readonly<Record<string, { filterableColumns?: readonly string[] }>> = R.RESOURCES;
    expect(Object.keys(CONFIG)).toEqual(
      expect.arrayContaining([
        'services',
        'disciplines',
        'portfolio',
        'pages',
        'sectors',
        'clients',
      ]),
    );
    for (const [slug, ui] of Object.entries(RESOURCE_UI)) {
      for (const field of ui.fields) {
        const relation = field.relation;
        if (!relation?.filter) continue;
        const target = CONFIG[relation.resource];
        expect(target, `${slug}.${field.name} → ${relation.resource}`).toBeDefined();
        for (const column of Object.keys(relation.filter)) {
          const ok = column === 'status' || (target!.filterableColumns ?? []).includes(column);
          expect(ok, `${slug}.${field.name}: ${column}`).toBe(true);
        }
      }
    }
  });

  it('the list endpoint applies status.neq as a not-equal filter, and refuses an unknown status', async () => {
    const { GET } = collectionRoutes(R.serviceResource);
    const ok = await call(
      GET,
      ctx('content_creator', 'GET', undefined, '?limit=100&status.neq=archived'),
    );
    expect(ok.status).toBe(200);
    expect(calls).toContainEqual({ table: 'services', op: 'neq', args: ['status', 'archived'] });
    const bad = await call(GET, ctx('content_creator', 'GET', undefined, '?status.neq=gone'));
    expect(bad.status).toBe(422);
  });

  it('a project that still links an archived service keeps that link when saved', async () => {
    // The form loads the stored links in order — the archived one included …
    const fields = RESOURCE_UI['portfolio']!.fields;
    const loaded = R.portfolioResource.fromRow!({
      id: ID,
      title: t('The Rider'),
      portfolio_services: [
        { service_id: ARCHIVED_SVC, sort_order: 0 },
        { service_id: LIVE_SVC, sort_order: 1 },
      ],
      portfolio_media: [],
    });
    const form = rowToForm(loaded, fields);
    expect(form['serviceIds']).toEqual([ARCHIVED_SVC, LIVE_SVC]);
    // … the payload carries every stored id, whatever the picker offers …
    const payload = formToPayload(form, fields);
    expect(payload['serviceIds']).toEqual([ARCHIVED_SVC, LIVE_SVC]);
    // … and the save hands save_portfolio exactly that set, in that order.
    const { PATCH } = itemRoutes(R.portfolioResource);
    const res = await call(
      PATCH,
      ctx('content_creator', 'PATCH', { serviceIds: payload['serviceIds'], version: 1 }),
    );
    expect(res.status).toBe(200);
    expect(rpcCalls.at(-1)?.args['p_service_ids']).toEqual([ARCHIVED_SVC, LIVE_SVC]);
  });
});

describe('services: the page fields', () => {
  it('maps the new fields to their columns; the clip fills the three preview columns', () => {
    const row = R.serviceResource.toRow({
      disciplineId: DISC,
      intro: t('A logo is a promise.'),
      valuePoints: [{ title: t('t'), text: t('d') }],
      deliverables: [t('Two or three routes')],
      posterMediaId: ID,
      clip: { path: '/media/showreel.mp4', startS: 5.9, endS: 6.9 },
    });
    expect(row).toEqual({
      discipline_id: DISC,
      intro: t('A logo is a promise.'),
      value_points: [{ title: t('t'), text: t('d') }],
      deliverables: [t('Two or three routes')],
      poster_media_id: ID,
      preview_video_path: '/media/showreel.mp4',
      preview_start_s: 5.9,
      preview_end_s: 6.9,
    });
    // there is no uid column on services: nothing may write one
    expect(row).not.toHaveProperty('preview_video_uid');
    expect(R.serviceResource.toRow({ clip: null })).toEqual({
      preview_video_path: null,
      preview_start_s: null,
      preview_end_s: null,
    });
  });

  it('the form reads the clip back under `preview`', () => {
    const row = R.serviceResource.fromRow!({
      preview_video_path: '/media/showreel.mp4',
      preview_start_s: 5.9,
      preview_end_s: 6.9,
    });
    expect(row['preview']).toEqual({ path: '/media/showreel.mp4', startS: 5.9, endS: 6.9 });
  });

  it('a Stream clip is refused on the field (no column could hold it)', async () => {
    const { PATCH } = itemRoutes(R.serviceResource);
    const res = await call(
      PATCH,
      ctx('admin', 'PATCH', { clip: { streamUid: 'a'.repeat(32) }, version: 1 }),
    );
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain('clip');
  });

  it('publishing needs a discipline (not a DB CHECK — the cut-over renames first)', async () => {
    const { PATCH } = itemRoutes(R.serviceResource);
    stored = { title: t('Logo Design'), discipline_id: null };
    const refused = await call(PATCH, ctx('admin', 'PATCH', { status: 'published', version: 1 }));
    expect(refused.status).toBe(422);
    expect(refused.body['field']).toBe('disciplineId');
    stored = { title: t('Logo Design'), discipline_id: DISC };
    expect(
      (await call(PATCH, ctx('admin', 'PATCH', { status: 'published', version: 1 }))).status,
    ).toBe(200);
  });
});

describe('disciplines', () => {
  it('create maps name, card line, description, poster and clip', async () => {
    const { POST } = collectionRoutes(R.disciplineResource);
    const res = await call(
      POST,
      ctx('content_creator', 'POST', {
        slug: 'branding',
        name: t('Branding'),
        short: t('The mark, the system.'),
        blurb: t('We give a brand a face.'),
        posterMediaId: ID,
        clip: { path: '/media/showreel.mp4', startS: 5.9, endS: 7.9 },
        sortOrder: 10,
      }),
    );
    expect(res.status).toBe(200);
    expect(written).toMatchObject({
      tenant_id: TENANT,
      slug: 'branding',
      short: t('The mark, the system.'),
      poster_media_id: ID,
      preview_video_path: '/media/showreel.mp4',
      preview_start_s: 5.9,
      preview_end_s: 7.9,
      sort_order: 10,
      status: 'draft',
    });
  });

  it('a duplicate slug is blamed on the slug', async () => {
    const { POST } = collectionRoutes(R.disciplineResource);
    writeError = {
      code: '23505',
      message: 'duplicate key value violates unique constraint "disciplines_tenant_id_slug_key"',
    };
    const res = await call(POST, ctx('admin', 'POST', { slug: 'branding', name: t('Branding') }));
    expect(res.status).toBe(422);
    expect(res.body['field']).toBe('slug');
  });

  it('archiving is Admin-only; publishing is the publish capability', async () => {
    const { PATCH } = itemRoutes(R.disciplineResource);
    stored = { name: t('Branding') };
    expect(
      (await call(PATCH, ctx('content_creator', 'PATCH', { status: 'archived', version: 1 })))
        .status,
    ).toBe(403);
    expect(
      (await call(PATCH, ctx('content_creator', 'PATCH', { status: 'published', version: 1 })))
        .status,
    ).toBe(200);
  });
});

describe('service cases', () => {
  const body = {
    serviceId: LIVE_SVC,
    portfolioId: ID,
    title: t('A school group rebrand'),
    context: t('Four campuses, four logos.'),
    problems: [{ problem: t('p'), solution: t('s') }],
    results: [{ value: '4', label: t('campuses under one mark') }],
  };

  it('create maps every field to its column', async () => {
    const { POST } = collectionRoutes(R.serviceCaseResource);
    expect((await call(POST, ctx('content_creator', 'POST', body))).status).toBe(200);
    expect(written).toMatchObject({
      service_id: LIVE_SVC,
      portfolio_id: ID,
      title: body.title,
      problems: body.problems,
      results: body.results,
      is_placeholder: false,
    });
  });

  it('a second case for the same service gets a friendly message on the service field', async () => {
    const { POST } = collectionRoutes(R.serviceCaseResource);
    writeError = {
      code: '23505',
      message:
        'duplicate key value violates unique constraint "service_cases_tenant_id_service_id_key"',
    };
    const res = await call(POST, ctx('admin', 'POST', body));
    expect(res.status).toBe(422);
    expect(res.body['field']).toBe('serviceId');
    expect(String(res.body['detail'])).toContain('already has a case study block');
  });

  it('a design sample (or a placeholder figure) is refused on publish', async () => {
    const { PATCH } = itemRoutes(R.serviceCaseResource);
    stored = { title: body.title, results: body.results, is_placeholder: true };
    const sample = await call(PATCH, ctx('admin', 'PATCH', { status: 'published', version: 1 }));
    expect(sample.status).toBe(422);
    expect(sample.body['field']).toBe('isPlaceholder');
    stored = {
      title: body.title,
      results: [{ value: '+XX%', label: t('x') }],
      is_placeholder: false,
    };
    expect(
      (await call(PATCH, ctx('admin', 'PATCH', { status: 'published', version: 1 }))).status,
    ).toBe(422);
    stored = { title: body.title, results: body.results, is_placeholder: false };
    expect(
      (await call(PATCH, ctx('admin', 'PATCH', { status: 'published', version: 1 }))).status,
    ).toBe(200);
  });
});

describe('the testimonial sample lock (0028) is said in words, not a bare 403', () => {
  const lock = (message: string) => ({ code: '42501', message });

  it('editing a sample’s words', async () => {
    const { PATCH } = itemRoutes(R.testimonialResource);
    writeError = lock(
      'testimonial quote-home-1 is a design sample: its words and attribution are locked',
    );
    const res = await call(PATCH, ctx('admin', 'PATCH', { quote: t('New words'), version: 1 }));
    expect(res.status).toBe(422);
    expect(res.body['field']).toBe('isPlaceholder');
    expect(res.body['detail']).toBe(
      'Sample quotes can’t be edited; replace the words, set consent and untick Placeholder in one save.',
    );
  });

  it('creating one, or turning a real quote into one', async () => {
    const { POST } = collectionRoutes(R.testimonialResource);
    writeError = lock('testimonial q cannot be created as a design sample');
    const created = await call(
      POST,
      ctx('admin', 'POST', { slug: 'q', quote: t('q'), authorName: t('a'), isPlaceholder: true }),
    );
    expect(created.status).toBe(422);
    expect(String(created.body['detail'])).toContain('can’t be a design sample');
    const { PATCH } = itemRoutes(R.testimonialResource);
    writeError = lock('testimonial q cannot be turned into a design sample');
    const turned = await call(PATCH, ctx('admin', 'PATCH', { isPlaceholder: true, version: 1 }));
    expect(turned.status).toBe(422);
    expect(String(turned.body['detail'])).toContain('can’t be turned back');
  });

  it('any OTHER 42501 is still a 403 (an RLS refusal is not an editing tip)', async () => {
    const { PATCH } = itemRoutes(R.testimonialResource);
    writeError = lock('new row violates row-level security policy for table "testimonials"');
    expect((await call(PATCH, ctx('admin', 'PATCH', { quote: t('x'), version: 1 }))).status).toBe(
      403,
    );
  });
});

describe('links must name a row of the caller’s own tenant (checked before the write)', () => {
  it('a poster from another tenant (not DB-fenced on disciplines/services) is refused', async () => {
    missing.add('media_assets');
    const { POST } = collectionRoutes(R.disciplineResource);
    const res = await call(
      POST,
      ctx('admin', 'POST', { slug: 'branding', name: t('Branding'), posterMediaId: ID }),
    );
    expect(res.status).toBe(422);
    expect(res.body['field']).toBe('posterMediaId');
    expect(written).toBeNull(); // refused before any write
    // the lookup was scoped to the caller's tenant and to images
    expect(calls).toContainEqual({ table: 'media_assets', op: 'eq', args: ['tenant_id', TENANT] });
    expect(calls).toContainEqual({ table: 'media_assets', op: 'eq', args: ['kind', 'image'] });
  });

  it('a service filed under another tenant’s discipline is refused on the discipline field', async () => {
    missing.add('disciplines');
    const { PATCH } = itemRoutes(R.serviceResource);
    const res = await call(PATCH, ctx('admin', 'PATCH', { disciplineId: DISC, version: 1 }));
    expect(res.status).toBe(422);
    expect(res.body['field']).toBe('disciplineId');
  });

  it('a case pointed at another tenant’s project is refused on the project field', async () => {
    missing.add('portfolio');
    const { POST } = collectionRoutes(R.serviceCaseResource);
    const res = await call(
      POST,
      ctx('admin', 'POST', { serviceId: LIVE_SVC, portfolioId: ID, title: t('x') }),
    );
    expect(res.status).toBe(422);
    expect(res.body['field']).toBe('portfolioId');
  });

  it('a write that does not touch a link does not look it up', async () => {
    missing.add('media_assets');
    const { PATCH } = itemRoutes(R.disciplineResource);
    expect((await call(PATCH, ctx('admin', 'PATCH', { short: t('x'), version: 1 }))).status).toBe(
      200,
    );
    expect(calls.some((c) => c.table === 'media_assets')).toBe(false);
  });

  it('deleting a discipline that still has services is a 409 that says why', async () => {
    const { DELETE } = itemRoutes(R.disciplineResource);
    writeError = null;
    const c = ctx('admin', 'DELETE');
    // the DELETE is refused by services.discipline_id (on delete restrict)
    (c.locals as unknown as { supabase: unknown }).supabase = {
      from: () => {
        const b: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'delete']) b[m] = () => b;
        b['maybeSingle'] = async () => ({ data: { id: ID }, error: null });
        b['then'] = (ok: (v: unknown) => unknown) =>
          Promise.resolve({
            data: null,
            error: {
              code: '23503',
              message:
                'update or delete on table "disciplines" violates foreign key constraint "services_discipline_id_fkey" on table "services"',
            },
          }).then(ok);
        return b;
      },
    };
    const res = await call(DELETE, c);
    expect(res.status).toBe(409);
    expect(String(res.body['detail'])).toContain('services are still filed under');
  });
});
