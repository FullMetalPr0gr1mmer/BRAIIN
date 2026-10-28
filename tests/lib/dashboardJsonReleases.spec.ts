import { describe, expect, it, vi } from 'vitest';
import type { APIRoute } from 'astro';
import { makeContext, serviceClientStub, type Principal } from '../authz/harness';

// GET /api/admin/dashboard, the dashboard's JSON twin, follows /admin on the publish card
// (Admin v2 R13, review C6): while releases are off for the tenant the release widgets are
// neither in the layout nor in the widgets, as the page leaves them off the board, Add widget
// and the presets; with releases on the layout is the person's own.

vi.mock('@/lib/supabase/server', () => ({ serviceClient: serviceClientStub }));
vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));
vi.mock('@/lib/admin/dashboard/loaders', () => ({
  loadDashboard: async () => ({
    layout: {
      top: ['kpis'],
      left: ['attention'],
      right: ['publish', 'notes'],
      hidden: [],
    },
    source: 'default',
    widgets: { kpis: { ok: true }, publish: { ok: true, data: null } },
    banners: [],
  }),
}));

const { GET } = (await import('@/pages/api/admin/dashboard')) as { GET: APIRoute };

async function call(principal: Principal, releases: boolean) {
  const ctx = makeContext(
    principal,
    '/api/admin/dashboard',
    undefined,
    'GET',
    {},
    {
      ...(releases ? { releases: true as const } : {}),
    },
  );
  const res = (await GET(ctx)) as Response;
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: Record<string, unknown> }).data;
}

describe('GET /api/admin/dashboard and the publish card', () => {
  it('releases off: the card is in neither the layout nor the widgets', async () => {
    const data = await call('content_creator', false);
    expect(data['layout']).toEqual({
      top: ['kpis'],
      left: ['attention'],
      right: ['notes'],
      hidden: [],
    });
    expect(Object.keys(data['widgets'] as object)).toEqual(['kpis']);
  });

  it('releases on: the layout as stored, the card in it', async () => {
    const data = await call('admin', true);
    expect((data['layout'] as { right: string[] }).right).toEqual(['publish', 'notes']);
    expect(Object.keys(data['widgets'] as object)).toEqual(['kpis', 'publish']);
  });
});
