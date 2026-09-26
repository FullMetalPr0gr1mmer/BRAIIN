import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIRoute } from 'astro';
import type { Role } from '@/lib/auth/types';

// The UI v2 content resources (PR4b) through the real kernel routes, against a stubbed
// client: what reaches save_portfolio(), how its errors come back, the publish rules the
// public pages depend on, and the statistics value the 0023 CHECK insists on.

vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));
vi.mock('@/lib/admin/audit', () => ({ writeAudit: async () => undefined }));

const { collectionRoutes, itemRoutes } = await import('@/lib/admin/resource');
const R = await import('@/lib/admin/resources');

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID = '11111111-1111-4111-8111-111111111111';
const SVC = '22222222-2222-4222-8222-222222222222';
const MEDIA = '33333333-3333-4333-8333-333333333333';
const t = (en: string) => ({ en, ar: `ع-${en}` });

let stored: Record<string, unknown> = {};
let rpcResult: { data: unknown; error: unknown } = { data: [{ id: ID, version: 2 }], error: null };
let rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
let posterAlt: unknown = t('A poster');

function stubDb() {
  const make = (table: string) => {
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'order', 'range', 'insert', 'update', 'delete', 'ilike']) {
      b[m] = () => b;
    }
    const row = () =>
      table === 'media_assets' ? { alt: posterAlt } : { id: ID, version: 1, ...stored };
    b['single'] = async () => ({ data: row(), error: null });
    b['maybeSingle'] = async () => ({ data: row(), error: null });
    return b;
  };
  return {
    from: (table: string) => make(table),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return rpcResult;
    },
  };
}

function ctx(role: Role, method: string, body: unknown) {
  const url = new URL(`https://admin.example.test/api/admin/x/${ID}`);
  return {
    request: new Request(url, {
      method,
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
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
  rpcResult = { data: [{ id: ID, version: 2 }], error: null };
  rpcCalls = [];
  posterAlt = t('A poster');
});

describe('portfolio saves through save_portfolio() — one transaction', () => {
  it('create: column patch, ordered services and the media set in ONE call', async () => {
    const { POST } = collectionRoutes(R.portfolioResource);
    const res = await call(
      POST,
      ctx('content_creator', 'POST', {
        slug: 'the-rider',
        title: t('The Rider'),
        year: 2026,
        preview: { path: '/media/showreel.mp4', startS: 1, endS: 3.7 },
        serviceIds: [SVC],
        media: [
          {
            role: 'hero',
            kind: 'video',
            mediaId: MEDIA,
            clip: { path: '/media/showreel.mp4', startS: 1, endS: 3 },
          },
          {
            role: 'breakdown',
            kind: 'image',
            mediaId: MEDIA,
            breakdownKind: 'sketch',
            layout: 'half',
            caption: t('c'),
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    expect(rpcCalls).toHaveLength(1);
    const { fn, args } = rpcCalls[0]!;
    expect(fn).toBe('save_portfolio');
    expect(args['p_id']).toBeNull();
    expect(args['p_version']).toBeNull();
    expect(args['p_service_ids']).toEqual([SVC]);
    expect(args['p_values']).toMatchObject({
      slug: 'the-rider',
      year: 2026,
      preview_video_path: '/media/showreel.mp4',
      preview_video_uid: null,
      preview_start_s: 1,
      preview_end_s: 3.7,
    });
    expect(args['p_media']).toEqual([
      {
        role: 'hero',
        kind: 'video',
        media_id: MEDIA,
        video_uid: null,
        video_path: '/media/showreel.mp4',
        clip_start_s: 1,
        clip_end_s: 3,
        duration_label: null,
        caption: null,
        breakdown_kind: null,
        layout: null,
      },
      {
        role: 'breakdown',
        kind: 'image',
        media_id: MEDIA,
        video_uid: null,
        video_path: null,
        clip_start_s: null,
        clip_end_s: null,
        duration_label: null,
        caption: t('c'),
        breakdown_kind: 'sketch',
        layout: 'half',
      },
    ]);
  });

  it('update: a child set alone is a real edit; a truly empty PATCH is still 422', async () => {
    const { PATCH } = itemRoutes(R.portfolioResource);
    expect(
      (await call(PATCH, ctx('admin', 'PATCH', { serviceIds: [SVC], version: 1 }))).status,
    ).toBe(200);
    expect(rpcCalls[0]?.args).toMatchObject({
      p_id: ID,
      p_version: 1,
      p_values: {},
      p_media: null,
    });
    expect((await call(PATCH, ctx('admin', 'PATCH', { version: 1 }))).status).toBe(422);
  });

  it('maps the function’s errors: stale version 409, missing 404, reserved slug 422 on the slug', async () => {
    const { PATCH } = itemRoutes(R.portfolioResource);
    rpcResult = { data: null, error: { code: '40001', message: 'modified by someone else' } };
    expect((await call(PATCH, ctx('admin', 'PATCH', { year: 2025, version: 1 }))).status).toBe(409);
    rpcResult = { data: null, error: { code: 'P0002', message: 'not found' } };
    expect((await call(PATCH, ctx('admin', 'PATCH', { year: 2025, version: 1 }))).status).toBe(404);
    rpcResult = {
      data: null,
      error: {
        code: '23514',
        message: 'new row violates check constraint "portfolio_slug_not_reserved"',
      },
    };
    const res = await call(PATCH, ctx('admin', 'PATCH', { slug: 'all', version: 1 }));
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain('slug');
  });

  it('loads the child sets back in order, for the form', () => {
    const row = R.portfolioResource.fromRow!({
      id: ID,
      preview_video_uid: null,
      preview_video_path: '/media/showreel.mp4',
      preview_start_s: 1,
      preview_end_s: 3.7,
      portfolio_services: [
        { service_id: 'b', sort_order: 1 },
        { service_id: 'a', sort_order: 0 },
      ],
      portfolio_media: [
        { role: 'gallery', kind: 'image', media_id: MEDIA, sort_order: 1 },
        {
          role: 'hero',
          kind: 'video',
          media_id: MEDIA,
          video_path: '/media/showreel.mp4',
          clip_start_s: 1,
          clip_end_s: 3,
          sort_order: 0,
        },
      ],
    });
    expect(row['service_ids']).toEqual(['a', 'b']);
    expect(row['preview']).toEqual({ path: '/media/showreel.mp4', startS: 1, endS: 3.7 });
    expect(row['media']).toEqual([
      {
        role: 'hero',
        kind: 'video',
        mediaId: MEDIA,
        clip: { path: '/media/showreel.mp4', startS: 1, endS: 3 },
      },
      { role: 'gallery', kind: 'image', mediaId: MEDIA },
    ]);
    expect(row).not.toHaveProperty('portfolio_services');
  });
});

describe('portfolio publish rules (what a card and a case study need)', () => {
  const live = {
    title: t('The Rider'),
    project_type: t('Brand film'),
    poster_media_id: MEDIA,
    results: [{ value: '3.2M', label: t('Views') }],
    is_placeholder: false,
  };
  const publish = async (row: Record<string, unknown>) => {
    stored = row;
    const { PATCH } = itemRoutes(R.portfolioResource);
    return call(PATCH, ctx('admin', 'PATCH', { status: 'published', version: 1 }));
  };

  it('publishes a complete case study', async () => {
    expect((await publish(live)).status).toBe(200);
  });

  it('refuses a placeholder, a placeholder figure, a missing type or poster, a poster without alt', async () => {
    expect((await publish({ ...live, is_placeholder: true })).status).toBe(422);
    expect((await publish({ ...live, results: [{ value: 'XXM', label: t('v') }] })).status).toBe(
      422,
    );
    expect((await publish({ ...live, project_type: null })).status).toBe(422);
    expect((await publish({ ...live, poster_media_id: null })).status).toBe(422);
    posterAlt = { en: 'only English' };
    expect((await publish(live)).status).toBe(422);
  });
});

describe('statistics: the displayed value is the number plus its suffix', () => {
  it('derives value from a count-up number (the 0023 CHECK cannot be violated by a save)', () => {
    expect(R.statisticResource.toRow({ valueNumeric: 250, valueSuffix: '+' })).toMatchObject({
      value: '250+',
    });
    expect(R.statisticResource.toRow({ valueNumeric: 1.5, valueSuffix: null })).toMatchObject({
      value: '1.5',
    });
    expect(R.statisticResource.toRow({ value: 'Top 10' })).toEqual({ value: 'Top 10' });
  });

  it('per-page labels round-trip between the column object and the form list', async () => {
    const row = R.statisticResource.fromRow!({ placement_labels: { about: t('Delivered') } });
    expect(row['placement_labels']).toEqual([{ placement: 'about', label: t('Delivered') }]);
    const { StatisticUpdateSchema } = await import('@schemas/admin');
    const parsed = StatisticUpdateSchema.parse({
      version: 1,
      placementLabels: row['placement_labels'],
    });
    expect(parsed.placementLabels).toEqual({ about: t('Delivered') });
  });
});

describe('testimonials and clients go live only when real', () => {
  it('a quote without consent is refused on publish; with consent it goes', async () => {
    const { PATCH } = itemRoutes(R.testimonialResource);
    stored = {
      quote: t('q'),
      author_name: t('a'),
      consent_obtained_at: null,
      is_placeholder: false,
    };
    expect(
      (await call(PATCH, ctx('admin', 'PATCH', { status: 'published', version: 1 }))).status,
    ).toBe(422);
    stored = { ...stored, consent_obtained_at: '2026-09-01T00:00:00Z' };
    expect(
      (await call(PATCH, ctx('admin', 'PATCH', { status: 'published', version: 1 }))).status,
    ).toBe(200);
  });

  it('a placeholder client cannot be cleared for disclosure', async () => {
    const { PATCH } = itemRoutes(R.clientResource);
    stored = { name: t('Client A'), is_placeholder: true };
    expect((await call(PATCH, ctx('admin', 'PATCH', { visible: true, version: 1 }))).status).toBe(
      422,
    );
  });
});
