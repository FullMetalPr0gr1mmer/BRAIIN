import { describe, expect, it, vi } from 'vitest';
import type { APIRoute } from 'astro';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DashboardLayout, WidgetId } from '@schemas/dashboard';
import type { AuthContext, Role } from '@/lib/auth/types';
import {
  keepReleasePlacement,
  resolveLayout,
  shownWidgets,
  unnamedReleaseWidgets,
  withoutWidgets,
} from '@/lib/admin/dashboard/layout';
import { presetValues, type RolePreset } from '@/lib/admin/dashboard/roleDefaults';
import { RELEASE_WIDGETS } from '@/lib/admin/dashboard/widgets';

// A person's hide of the publish card survives releases going off and on again (Admin v2
// R14-prep code review 1). While releases are off the dashboard strips the release widgets from
// the board and Add widget (R13), so every save made then names the card nowhere; R14-prep's
// rule gives a card that a layout names nowhere its default place. Without the save keeping the
// stored placement, a person who hid the card, saved their board while releases were off, and
// saw releases come back on would find the card back on their board. The same for a role preset
// an Admin saves while releases are off.

vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));

const layout = (
  top: WidgetId[],
  left: WidgetId[],
  right: WidgetId[],
  hidden: WidgetId[] = [],
): DashboardLayout => ({ top, left, right, hidden });

/** The board the person saw while releases were off: their layout, the card stripped. */
const offBoard = (stored: unknown, role: Role): DashboardLayout =>
  withoutWidgets(resolveLayout(stored, null, role).layout, RELEASE_WIDGETS);

/** Releases off, the person rearranges: the board they saw, with `notes` moved to the top. */
const rearranged = (board: DashboardLayout): DashboardLayout => ({
  ...board,
  top: [...board.top, 'notes'],
  left: board.left.filter((id) => id !== 'notes'),
  right: board.right.filter((id) => id !== 'notes'),
  hidden: board.hidden.filter((id) => id !== 'notes'),
});

describe('a save keeps the release widgets it names nowhere where they were', () => {
  it('hidden while on, a save while off, on again: still hidden', () => {
    const hid = layout(['kpis'], ['quick', 'views'], ['attention'], ['publish']);
    const saved = keepReleasePlacement(rearranged(offBoard(hid, 'admin')), hid, 'admin');
    expect(saved.hidden).toContain('publish');
    const back = resolveLayout(saved, null, 'admin').layout;
    expect(shownWidgets(back)).not.toContain('publish');
    expect(back.top).toEqual(['kpis', 'notes']);
  });

  it('moved while on, a save while off, on again: in its column, at its place', () => {
    const moved = layout(['kpis'], ['quick', 'publish', 'views'], ['attention']);
    const saved = keepReleasePlacement(rearranged(offBoard(moved, 'seo')), moved, 'seo');
    expect(saved.left).toEqual(['quick', 'publish', 'views']);
    expect(resolveLayout(saved, null, 'seo').layout.left).toEqual(['quick', 'publish', 'views']);
  });

  it('a stored layout that never named it: still unnamed, so on again it takes its default place', () => {
    const before = layout(['kpis'], ['quick'], ['attention']);
    const next = rearranged(offBoard(before, 'developer'));
    const saved = keepReleasePlacement(next, before, 'developer');
    expect(unnamedReleaseWidgets(saved, 'developer')).toEqual(['publish']);
    expect(resolveLayout(saved, null, 'developer').layout.right[0]).toBe('publish');
  });

  it('a save that names it is the person’s choice: never overridden', () => {
    const stored = layout(['kpis'], ['publish'], []);
    const next = layout(['kpis'], [], [], ['publish']);
    expect(unnamedReleaseWidgets(next, 'admin')).toEqual([]);
    expect(keepReleasePlacement(next, stored, 'admin')).toBe(next);
  });

  it('a Reset (no columns), a role without the card and an empty store change nothing', () => {
    const stored = layout([], [], [], ['publish']);
    const reset = { quickSet: true };
    expect(keepReleasePlacement(reset, stored, 'admin')).toBe(reset);
    const sales = layout(['kpis'], ['quick'], []);
    expect(unnamedReleaseWidgets(sales, 'sales')).toEqual([]);
    expect(keepReleasePlacement(sales, stored, 'sales')).toBe(sales);
    const next = layout(['kpis'], [], []);
    expect(keepReleasePlacement(next, {}, 'admin')).toBe(next);
  });
});

describe('a role preset saved while releases are off keeps its card placement', () => {
  const stored = (dashboard: unknown): RolePreset => ({
    role: 'content_creator',
    version: 3,
    dashboard,
    quickActions: [],
    updatedAt: null,
  });

  it('a preset that hid the card keeps it hidden; one that placed it keeps it there', () => {
    const board = layout(['kpis'], ['quick'], ['attention'], ['notes']);
    const hid = presetValues(
      'content_creator',
      { dashboard: board },
      stored(layout(['kpis'], [], [], ['publish'])),
    );
    expect(hid.dashboard.hidden).toEqual(['publish', 'notes']);
    const placed = presetValues(
      'content_creator',
      { dashboard: board },
      stored(layout([], ['publish'], [])),
    );
    expect(placed.dashboard.left).toEqual(['publish', 'quick']);
    // A preset that never named it: the default place once releases are on.
    const never = presetValues('content_creator', { dashboard: board }, stored({}));
    expect(resolveLayout({}, never.dashboard, 'content_creator').layout.right[0]).toBe('publish');
  });
});

// ── PUT /api/admin/me/preferences ───────────────────────────────────────────────────────

interface Call {
  table: string;
  op: 'select' | 'update' | 'insert';
  payload?: unknown;
}

/** The person's row and their role's preset, as the route reads them; the write recorded. */
function prefsDb(mine: unknown, preset: unknown) {
  const calls: Call[] = [];
  const sb = {
    from: (table: string) => {
      const call: Call = { table, op: 'select' };
      calls.push(call);
      const builder: Record<string, unknown> = {
        select: () => builder,
        update: (payload: unknown) => {
          call.op = 'update';
          call.payload = payload;
          return builder;
        },
        insert: (payload: unknown) => {
          call.op = 'insert';
          call.payload = payload;
          return builder;
        },
        eq: () => builder,
        maybeSingle: async () => {
          if (call.op !== 'select') {
            return {
              data: {
                notifications: {},
                notifications_seen_at: null,
                dashboard: (call.payload as { dashboard?: unknown }).dashboard ?? {},
                quick_actions: [],
                version: 5,
              },
              error: null,
            };
          }
          if (table === 'admin_role_defaults') {
            return {
              data:
                preset === null
                  ? null
                  : {
                      role: 'admin',
                      dashboard: preset,
                      quick_actions: [],
                      version: 1,
                      updated_at: null,
                    },
              error: null,
            };
          }
          return {
            data: mine === null ? null : { dashboard: mine, quick_actions: [], version: 4 },
            error: null,
          };
        },
      };
      return builder;
    },
  };
  return { sb: sb as unknown as SupabaseClient, calls };
}

const auth = (role: Role): AuthContext => ({
  userId: 'u-1',
  tenantId: 't-1',
  role,
  isActive: true,
  email: 'sam@example.test',
});

async function put(role: Role, sb: SupabaseClient, body: unknown) {
  const route = (await import('@/pages/api/admin/me/preferences')).PUT as APIRoute;
  const url = new URL('/api/admin/me/preferences', 'https://admin.example.test');
  const request = new Request(url, {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
  const res = (await route({
    request,
    url,
    params: {},
    locals: { session: auth(role), supabase: sb, cspNonce: 'test', csrfToken: 'test' },
  } as unknown as Parameters<APIRoute>[0])) as Response;
  return res.status;
}

const written = (calls: Call[]) =>
  (calls.find((c) => c.op === 'update')?.payload as { dashboard: DashboardLayout }).dashboard;

describe('PUT /api/admin/me/preferences keeps the card where the person left it', () => {
  const board = layout(['kpis', 'notes'], ['quick', 'views'], ['attention']);

  it('their own layout hid it: the save made while releases are off keeps it hidden', async () => {
    const { sb, calls } = prefsDb(layout(['kpis'], ['quick'], [], ['publish', 'notes']), null);
    expect(await put('admin', sb, { version: 4, dashboard: board })).toBe(200);
    expect(written(calls).hidden).toEqual(['publish']);
    expect(shownWidgets(resolveLayout(written(calls), null, 'admin').layout)).not.toContain(
      'publish',
    );
    // Their own row was enough: the preset was not read.
    expect(calls.map((c) => `${c.table}:${c.op}`)).toEqual([
      'admin_user_prefs:select',
      'admin_user_prefs:update',
    ]);
  });

  it('a first arrangement over a preset that hid it keeps the preset’s hide', async () => {
    const { sb, calls } = prefsDb({}, layout(['kpis'], [], [], ['publish']));
    expect(await put('admin', sb, { version: 4, dashboard: board })).toBe(200);
    expect(written(calls).hidden).toEqual(['publish']);
    expect(calls.map((c) => `${c.table}:${c.op}`)).toEqual([
      'admin_user_prefs:select',
      'admin_role_defaults:select',
      'admin_user_prefs:update',
    ]);
  });

  it('a save that names the card reads nothing more and stores what it says', async () => {
    const { sb, calls } = prefsDb(layout([], [], [], ['publish']), null);
    const named = { ...board, right: ['publish', 'attention'] as WidgetId[] };
    expect(await put('admin', sb, { version: 4, dashboard: named })).toBe(200);
    expect(written(calls).right).toEqual(['publish', 'attention']);
    expect(calls.map((c) => `${c.table}:${c.op}`)).toEqual(['admin_user_prefs:update']);
  });
});
