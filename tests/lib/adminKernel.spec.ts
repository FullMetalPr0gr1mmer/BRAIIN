import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { translateWriteError, constraintOf } from '@/lib/admin/crud';
import { InUseError, ValidationError } from '@/lib/admin/errors';
import { AuthorizationError } from '@/lib/authz/errors';
import { collectionRoutes, itemRoutes, type ResourceConfig } from '@/lib/admin/resource';
import type { Role } from '@/lib/auth/types';

vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));
vi.mock('@/lib/admin/audit', () => ({ writeAudit: async () => undefined }));

// ── Postgres errors → what an editor is told ─────────────────────────────────────
describe('translateWriteError', () => {
  const KEY = {
    navigation_one_key_per_location: { field: 'isKey', message: 'Only one key link per menu.' },
  };

  it('reads the constraint name out of the message or details', () => {
    expect(
      constraintOf({
        message: 'duplicate key value violates unique constraint "services_slug_key"',
      }),
    ).toBe('services_slug_key');
    expect(constraintOf({ message: 'x', details: 'Key violates constraint "c1"' })).toBe('c1');
    expect(constraintOf({ message: 'no constraint here' })).toBeNull();
  });

  it('a mapped unique violation names its own field, not "slug"', () => {
    const err = translateWriteError(
      {
        code: '23505',
        message: 'duplicate key value violates unique constraint "navigation_one_key_per_location"',
      },
      'navigation',
      'write',
      KEY,
    ) as ValidationError;
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.field).toBe('isKey');
    expect(err.detail).toBe('Only one key link per menu.');
  });

  it('an unmapped unique violation keeps the old slug default', () => {
    const err = translateWriteError(
      { code: '23505', message: 'violates unique constraint "x_key"' },
      'services',
    ) as ValidationError;
    expect(err.field).toBe('slug');
  });

  it('a foreign-key violation on DELETE is "still in use" (409), naming the referrer', () => {
    const err = translateWriteError(
      {
        code: '23503',
        message:
          'update or delete on table "categories" violates foreign key constraint "blog_posts_category_id_fkey" on table "blog_posts"',
      },
      'categories',
      'delete',
    );
    expect(err).toBeInstanceOf(InUseError);
    expect((err as InUseError).detail).toContain("'blog_posts'");
  });

  it('a foreign-key violation on a WRITE is bad input (422)', () => {
    const err = translateWriteError(
      { code: '23503', message: 'insert or update violates foreign key constraint "x_fkey"' },
      'page_sections',
      'write',
    );
    expect(err).toBeInstanceOf(ValidationError);
  });

  it('42501 stays an authorization refusal; anything else is a server error', () => {
    expect(translateWriteError({ code: '42501', message: 'rls' }, 't')).toBeInstanceOf(
      AuthorizationError,
    );
    const other = translateWriteError({ code: 'XX000', message: 'boom' }, 't');
    expect(other).not.toBeInstanceOf(ValidationError);
    expect(other.message).toContain('boom');
  });
});

// ── Resource routes: what counts as going live ──────────────────────────────────
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID = '11111111-1111-4111-8111-111111111111';

function stubDb(stored: Record<string, unknown>) {
  const builder: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'insert', 'update', 'delete', 'range', 'order', 'is', 'ilike'])
    builder[m] = () => builder;
  builder['single'] = async () => ({ data: { id: ID, version: 1, ...stored }, error: null });
  builder['maybeSingle'] = async () => ({ data: { id: ID, version: 1, ...stored }, error: null });
  return { from: () => builder };
}

function ctx(role: Role, method: string, body: unknown, stored: Record<string, unknown> = {}) {
  const url = new URL(`https://admin.example.test/api/admin/things/${ID}`);
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
      supabase: stubDb(stored),
      cspNonce: 'n',
      csrfToken: 'c',
    },
  } as unknown as Parameters<APIRoute>[0];
}

const statusOf = async (route: APIRoute, c: Parameters<APIRoute>[0]) =>
  ((await route(c)) as Response).status;

const publishable = vi.fn();

/** An `undefined` in `extra` REMOVES that key (e.g. a resource with no status). */
type Extra = { [K in keyof ResourceConfig]?: ResourceConfig[K] | undefined };

function config(extra: Extra = {}): ResourceConfig {
  const schema = z.object({
    title: z.string().optional(),
    status: z.enum(['draft', 'scheduled', 'published', 'archived']).optional(),
    visible: z.boolean().optional(),
    version: z.number().int().optional(),
  });
  const base = {
    table: 'things',
    entity: 'thing',
    writeCap: 'pages.write',
    listColumns: 'id',
    columns: 'id,title,status,visible,version',
    orderBy: { column: 'id' },
    createSchema: schema,
    updateSchema: schema,
    toRow: (input: Record<string, unknown>) => {
      const out: Record<string, unknown> = {};
      for (const k of ['title', 'status', 'visible']) if (input[k] !== undefined) out[k] = input[k];
      return out;
    },
    statusOf: (input: Record<string, unknown>) => input['status'] as never,
    assertPublishable: publishable,
  };
  const merged: Record<string, unknown> = { ...base, ...extra };
  for (const [key, value] of Object.entries(extra)) if (value === undefined) delete merged[key];
  return merged as unknown as ResourceConfig;
}

// Braces matter: a function RETURNED from beforeEach is run as a teardown by vitest.
beforeEach(() => {
  publishable.mockReset();
});

describe('resource routes — the publish preconditions', () => {
  it('run for SCHEDULED too — the cron publishes later without asking again', async () => {
    const { POST } = collectionRoutes(config());
    expect(await statusOf(POST, ctx('admin', 'POST', { title: 'x', status: 'scheduled' }))).toBe(
      200,
    );
    expect(publishable).toHaveBeenCalledTimes(1);
  });

  it('refuse to schedule a row that could not be published', async () => {
    publishable.mockImplementation(() => {
      throw new ValidationError('needs an Arabic title');
    });
    const { PATCH } = itemRoutes(config());
    expect(
      await statusOf(
        PATCH,
        ctx('admin', 'PATCH', { status: 'scheduled', version: 1 }, { title: 'x' }),
      ),
    ).toBe(422);
  });

  it('see the MERGED row on a partial PATCH, and may be async', async () => {
    publishable.mockImplementation(async (row: Record<string, unknown>) => {
      expect(row['title']).toBe('stored title');
    });
    const { PATCH } = itemRoutes(config());
    expect(
      await statusOf(
        PATCH,
        ctx('admin', 'PATCH', { status: 'published', version: 1 }, { title: 'stored title' }),
      ),
    ).toBe(200);
    expect(publishable).toHaveBeenCalledTimes(1);
  });

  it('do not run for a draft save', async () => {
    const { POST } = collectionRoutes(config());
    await statusOf(POST, ctx('admin', 'POST', { title: 'x', status: 'draft' }));
    expect(publishable).not.toHaveBeenCalled();
  });
});

describe("resource routes — publishFlag: 'visible'", () => {
  it('turning visible on is a publish: preconditions run', async () => {
    const { PATCH } = itemRoutes(config({ publishFlag: 'visible', statusOf: undefined }));
    expect(await statusOf(PATCH, ctx('admin', 'PATCH', { visible: true, version: 1 }))).toBe(200);
    expect(publishable).toHaveBeenCalledTimes(1);
  });

  it('turning visible on needs content.publish, beyond the write capability', async () => {
    // Developer holds settings.general (the write cap here) but NOT content.publish, so
    // a 403 can only come from the publish gate — and hiding stays allowed.
    const { PATCH } = itemRoutes(
      config({ writeCap: 'settings.general', publishFlag: 'visible', statusOf: undefined }),
    );
    expect(await statusOf(PATCH, ctx('developer', 'PATCH', { visible: true, version: 1 }))).toBe(
      403,
    );
    expect(await statusOf(PATCH, ctx('developer', 'PATCH', { visible: false, version: 1 }))).toBe(
      200,
    );
  });

  it('hiding is not a publish', async () => {
    const { PATCH } = itemRoutes(config({ publishFlag: 'visible', statusOf: undefined }));
    expect(await statusOf(PATCH, ctx('admin', 'PATCH', { visible: false, version: 1 }))).toBe(200);
    expect(publishable).not.toHaveBeenCalled();
  });
});

describe('resource routes — fromRow shapes every response', () => {
  it('applies to single-row reads and writes', async () => {
    const shaped = config({ fromRow: (row) => ({ ...row, label: `#${String(row['id'])}` }) });
    const { GET } = itemRoutes(shaped);
    const res = (await GET(ctx('admin', 'GET', undefined))) as Response;
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data['label']).toBe(`#${ID}`);
  });
});
