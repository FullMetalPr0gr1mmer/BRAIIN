import type { APIRoute } from 'astro';
import type { Role } from '@/lib/auth/types';
import { client, T, type Db, type Row } from './stagedDb';

// Driving a real admin route over the PostgREST stand-in (tests/fixtures/stagedDb.ts), as the
// signed-in person `user` with `role`, for the R3b specs.

export const ADMIN = '11111111-1111-4111-8111-111111111111';
export const OTHER_USER = '22222222-2222-4222-8222-222222222222';

/** An empty database for the caller's tenant, releases on. */
export function makeDb(tables: Record<string, Row[]> = {}): Db {
  return {
    tables: { content_drafts: [], content_release_items: [], audit_log: [], ...tables },
    flag: true,
    calls: [],
    user: ADMIN,
    now: () => new Date().toISOString(),
  };
}

export interface Answer {
  status: number;
  body: Row;
  data: Row;
}

export async function callRoute(
  db: Db,
  route: APIRoute,
  method: string,
  path: string,
  opts: { body?: unknown; role?: Role; user?: string; params?: Record<string, string> } = {},
): Promise<Answer> {
  const user = opts.user ?? ADMIN;
  db.user = user;
  const url = new URL(path, 'https://admin.example.test');
  const ctx = {
    request: new Request(url, {
      method,
      ...(opts.body === undefined
        ? {}
        : { body: JSON.stringify(opts.body), headers: { 'content-type': 'application/json' } }),
    }),
    url,
    params: opts.params ?? {},
    locals: {
      session: {
        userId: user,
        tenantId: T,
        role: opts.role ?? 'admin',
        isActive: true,
        email: 'a@example.test',
      },
      supabase: client(db),
      cspNonce: 'n',
      csrfToken: 'c',
    },
  } as unknown as Parameters<APIRoute>[0];
  const res = (await route(ctx)) as Response;
  const body = (await res.json()) as Row;
  return { status: res.status, body, data: (body['data'] ?? {}) as Row };
}

/** The audit actions written, in order. */
export const auditsOf = (db: Db) => (db.tables['audit_log'] ?? []).map((r) => r['action']);

/** The audit rows written, in order. */
export const auditRowsOf = (db: Db) => db.tables['audit_log'] ?? [];

/** Writes (insert/update/delete) to a live table. */
export const liveWritesOf = (db: Db, table: string) =>
  db.calls.filter((c) => c.kind === 'from' && c.name === table && c.op !== 'select');

/** Every touch of the drafts: a read or write of content_drafts, or the draft writer. */
export const draftTouchesOf = (db: Db) =>
  db.calls.filter((c) => c.name === 'content_drafts' || c.name === 'write_drafts');

/** A stored draft row, every column the readers select. */
export function draftRow(over: Row): Row {
  return {
    id: '77777777-7777-4777-8777-000000000001',
    tenant_id: T,
    entity_type: 'site_profile',
    entity_id: T,
    op: 'update',
    payload: {},
    fields: [],
    base: {},
    base_version: 1,
    label: null,
    version: 1,
    created_at: '2026-10-18T08:00:00Z',
    updated_at: '2026-10-18T08:00:00Z',
    created_by: ADMIN,
    updated_by: ADMIN,
    release_id: null,
    ...over,
  };
}
