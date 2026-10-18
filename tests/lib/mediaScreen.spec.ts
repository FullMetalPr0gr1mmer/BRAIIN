import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext, Role } from '@/lib/auth/types';

// The media library page's first render (Admin v2 U4, review sec-2): loadMediaScreen in
// src/lib/admin/mediaLibrary.ts, over a stub client that records every read. What it holds:
// an id that is not a UUID is a 404 with no read at all; another tenant's picture is a 404
// (the row read is tenant-scoped and finds nothing); a role outside media.write full or meta
// gets no data and no read (and a role ROLE_CAPS does not know never throws); a picture
// found opens with its preview.

vi.mock('@/lib/supabase/client', () => ({ supabaseConfigured: () => true }));
vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));

const { loadMediaScreen } = await import('@/lib/admin/mediaLibrary');

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ID = '11111111-1111-4111-8111-111111111111';
const KEY = `${TENANT}/7e3f9c2a-1b4d-4e8f-9a6b-5c3d2e1f0a9b_2560x1707.webp`;

interface Reads {
  rows: { table: string; filters: [string, unknown][] }[];
  rpcs: { fn: string; args: Record<string, unknown> }[];
}

/** A client whose `media_assets` holds one upload of TENANT, and that records every read. */
function client(reads: Reads): SupabaseClient {
  const stored = {
    id: ID,
    tenant_id: TENANT,
    provider: 'storage',
    storage_path: KEY,
    kind: 'image',
    width: 2560,
    height: 1707,
  };
  return {
    from(table: string) {
      const filters: [string, unknown][] = [];
      reads.rows.push({ table, filters });
      const b = {
        select: () => b,
        eq: (column: string, value: unknown) => {
          filters.push([column, value]);
          return b;
        },
        maybeSingle: async () => {
          const match = filters.every(([c, v]) => (stored as Record<string, unknown>)[c] === v);
          return { data: match ? stored : null, error: null };
        },
      };
      return b;
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      reads.rpcs.push({ fn, args });
      if (fn === 'media_library') return { data: { total: 0, rows: [] }, error: null };
      if (fn === 'media_storage_stats') return { data: [{ assets: 1, bytes: 10 }], error: null };
      return { data: null, error: null };
    },
  } as unknown as SupabaseClient;
}

const auth = (role: Role, tenantId = TENANT): AuthContext => ({
  userId: ID,
  tenantId,
  role,
  isActive: true,
  email: 'x@example.test',
});
const url = new URL('https://admin.example.test/admin/media');
const fresh = (): Reads => ({ rows: [], rpcs: [] });

describe('loadMediaScreen', () => {
  it('an id that is not a UUID is a 404 with no read at all', async () => {
    const reads = fresh();
    const screen = await loadMediaScreen(client(reads), auth('admin'), url, 'not-a-uuid');
    expect(screen.notFound).toBe(true);
    expect(screen.openRow).toBeNull();
    expect(reads).toEqual({ rows: [], rpcs: [] });
  });

  it('another tenant’s picture is a 404: the row read is scoped to the session’s tenant', async () => {
    const reads = fresh();
    const screen = await loadMediaScreen(client(reads), auth('admin', OTHER), url, ID);
    expect(screen.notFound).toBe(true);
    expect(screen.openRow).toBeNull();
    expect(reads.rows[0]?.filters).toContainEqual(['tenant_id', OTHER]);
    for (const call of reads.rpcs) expect(call.args['p_tenant']).toBe(OTHER);
  });

  it('a role outside media.write full or meta gets no data and makes no read', async () => {
    const reads = fresh();
    const screen = await loadMediaScreen(client(reads), auth('sales' as Role), url, ID);
    expect(screen).toMatchObject({
      initial: null,
      stats: null,
      openRow: null,
      canUpload: false,
      initialError: 'Your role does not allow that.',
      permissions: { write: false, hardDelete: false, opens: [] },
    });
    expect(reads).toEqual({ rows: [], rpcs: [] });
    // No session at all: the same.
    const none = await loadMediaScreen(client(reads), null, url);
    expect(none.initial).toBeNull();
    expect(reads).toEqual({ rows: [], rpcs: [] });
  });

  it('a picture of the tenant opens with its preview, through the caller’s own reads', async () => {
    const reads = fresh();
    const screen = await loadMediaScreen(client(reads), auth('seo'), url, ID);
    expect(screen.notFound).toBe(false);
    expect(screen.view.openId).toBe(ID);
    expect(screen.openRow).toMatchObject({ id: ID, provider: 'storage' });
    const preview = new URL(String(screen.openRow?.['preview_url']), 'https://x.test');
    expect(preview.searchParams.get('w')).toBe('640');
    expect(reads.rpcs.map((c) => c.fn).sort()).toEqual(['media_library', 'media_storage_stats']);
    expect(screen.permissions).toMatchObject({ write: false, hardDelete: false });
    expect(screen.subtitle).toBe(
      '1 file. Images are resized and compressed automatically for every screen.',
    );
  });
});
