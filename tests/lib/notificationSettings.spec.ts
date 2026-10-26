import { describe, expect, it, vi } from 'vitest';
import type { APIRoute } from 'astro';
import type { SupabaseClient } from '@supabase/supabase-js';
import { NOTIFICATION_KINDS, type NotificationKind } from '@schemas/adminPrefs';
import { NotificationSettingsPatchSchema } from '@schemas/notificationSettings';
import { ROLES, type AuthContext, type Role } from '@/lib/auth/types';
import { OptimisticLockError, ValidationError } from '@/lib/admin/errors';
import {
  mutedAfter,
  notificationSwitches,
  settingsOf,
  visibleKinds,
} from '@/lib/admin/notificationSettings';
import { NOTIFICATION_KIND_LABELS } from '@/lib/admin/notifications/kinds';
import { NOTIFICATION_SOURCES } from '@/lib/admin/notifications';

// The bell's settings (Admin v2 U11): a switch per kind of item the role's bell shows, over
// F8's stored mutes. A preference quiets the bell and never widens it: the switches are the
// kinds each source shows the role (ROLE_CAPS decides), a kind the role cannot see is a 422,
// and a mute kept from an earlier role is left alone. The route saves under the row's
// optimistic lock (a stale version is a 409).

vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));

/**
 * The kinds each role's bell shows, hand-written from §5 (each source's `visible`). Admin v2
 * R11's failed scheduled releases reach every role that publishes some area (not Sales).
 */
const VISIBLE: Record<Role, NotificationKind[]> = {
  admin: ['leads', 'applications', 'scheduled', 'maintenance', 'health', 'releases'],
  content_creator: ['scheduled', 'maintenance', 'releases'],
  seo: ['maintenance', 'releases'],
  developer: ['leads', 'maintenance', 'health', 'releases'],
  sales: ['leads', 'maintenance'],
};

const prefs = (muted: NotificationKind[], version = 4) => ({
  version,
  notifications: { muted },
  notificationsSeenAt: null,
});

describe('which switches a role gets', () => {
  it.each(ROLES)('%s: the kinds its bell shows, in the bell’s order', (role) => {
    expect(visibleKinds(role)).toEqual(VISIBLE[role]);
    expect(visibleKinds(role)).toEqual(
      NOTIFICATION_KINDS.filter((k) => NOTIFICATION_SOURCES[k].visible(role)),
    );
    expect(notificationSwitches(role).map((s) => s.kind)).toEqual(VISIBLE[role]);
  });

  it('every kind has its words, plain and with no dash (P-12)', () => {
    expect(Object.keys(NOTIFICATION_KIND_LABELS).sort()).toEqual([...NOTIFICATION_KINDS].sort());
    for (const { label, hint } of Object.values(NOTIFICATION_KIND_LABELS)) {
      expect(label.length).toBeGreaterThan(0);
      expect(hint).toMatch(/\.$/);
      expect(`${label} ${hint}`).not.toMatch(/[–—]/);
    }
  });
});

describe('the stored mutes as switches', () => {
  it('a muted kind is off, the others on; only the role’s kinds are named', () => {
    expect(settingsOf(prefs(['maintenance', 'leads']), 'seo')).toEqual({
      version: 4,
      maintenance: false,
      releases: true,
    });
    expect(settingsOf(prefs(['scheduled']), 'admin')).toEqual({
      version: 4,
      leads: true,
      applications: true,
      scheduled: false,
      maintenance: true,
      health: true,
      releases: true,
    });
  });

  it('a person with no row has everything on, at version 0', () => {
    expect(settingsOf(prefs([], 0), 'sales')).toEqual({
      version: 0,
      leads: true,
      maintenance: true,
    });
  });
});

describe('the mutes after a save', () => {
  it('off mutes, on unmutes, a kind left out keeps what it had', () => {
    expect(mutedAfter(['scheduled'], { version: 4, maintenance: false }, 'admin')).toEqual([
      'scheduled',
      'maintenance',
    ]);
    expect(
      mutedAfter(['scheduled', 'maintenance'], { version: 4, scheduled: true }, 'admin'),
    ).toEqual(['maintenance']);
  });

  it('keeps a mute of a kind the role cannot see (one set under an earlier role)', () => {
    expect(mutedAfter(['leads', 'scheduled'], { version: 4, maintenance: false }, 'seo')).toEqual([
      'leads',
      'scheduled',
      'maintenance',
    ]);
  });

  it.each([
    ['content_creator', 'leads'],
    ['seo', 'scheduled'],
    ['developer', 'applications'],
    ['sales', 'health'],
    ['seo', 'leads'],
  ] as const)('%s naming %s, which its bell never shows, is a 422', (role, kind) => {
    const run = () => mutedAfter([], { version: 4, [kind]: false }, role);
    expect(run).toThrow(ValidationError);
    expect(run).toThrow(`Not part of your bell: ${kind}`);
    // Even to turn it on: a preference never names what the role cannot see.
    expect(() => mutedAfter([], { version: 4, [kind]: true }, role)).toThrow(ValidationError);
  });

  it('the body is strict: a key that is no kind, or no version, is refused', () => {
    expect(NotificationSettingsPatchSchema.safeParse({ version: 1, email: true }).success).toBe(
      false,
    );
    expect(NotificationSettingsPatchSchema.safeParse({ maintenance: true }).success).toBe(false);
    expect(
      NotificationSettingsPatchSchema.safeParse({ version: 1, maintenance: 'off' }).success,
    ).toBe(false);
    expect(NotificationSettingsPatchSchema.parse({ version: 0, leads: false })).toEqual({
      version: 0,
      leads: false,
    });
  });
});

// ── The route ──────────────────────────────────────────────────────────────────────────

interface Call {
  op: 'select' | 'insert' | 'update';
  payload?: unknown;
  filters: [string, unknown][];
}

/** admin_user_prefs as a queue of answers, one per statement. */
function prefsDb(answers: { data?: unknown; error?: { code?: string; message: string } }[]) {
  const calls: Call[] = [];
  const sb = {
    from(table: string) {
      expect(table).toBe('admin_user_prefs');
      const call: Call = { op: 'select', filters: [] };
      calls.push(call);
      const builder: Record<string, unknown> = {
        select: () => builder,
        insert: (payload: unknown) => {
          call.op = 'insert';
          call.payload = payload;
          return builder;
        },
        update: (payload: unknown) => {
          call.op = 'update';
          call.payload = payload;
          return builder;
        },
        eq: (column: string, value: unknown) => {
          call.filters.push([column, value]);
          return builder;
        },
        maybeSingle: async () => {
          const answer = answers.shift() ?? {};
          return { data: answer.data ?? null, error: answer.error ?? null };
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

async function call(
  method: 'GET' | 'PATCH',
  role: Role,
  sb: SupabaseClient,
  body?: unknown,
): Promise<{ status: number; json: { data?: Record<string, unknown>; error?: unknown } }> {
  const route = (await import('@/pages/api/admin/me/notification-settings'))[method] as APIRoute;
  const url = new URL('/api/admin/me/notification-settings', 'https://admin.example.test');
  const request = new Request(url, {
    method,
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  });
  const res = (await route({
    request,
    url,
    params: {},
    locals: { session: auth(role), supabase: sb, cspNonce: 'test', csrfToken: 'test' },
  } as unknown as Parameters<APIRoute>[0])) as Response;
  return { status: res.status, json: (await res.json()) as never };
}

const ROW = (muted: string[], version = 4) => ({
  notifications: { muted },
  notifications_seen_at: null,
  dashboard: {},
  quick_actions: [],
  version,
});

describe('GET and PATCH /api/admin/me/notification-settings', () => {
  it('GET answers the role’s switches from the person’s own row', async () => {
    const { sb, calls } = prefsDb([{ data: ROW(['maintenance']) }]);
    const res = await call('GET', 'sales', sb);
    expect(res.status).toBe(200);
    expect(res.json.data).toEqual({ version: 4, leads: true, maintenance: false });
    expect(calls[0]!.filters).toEqual([
      ['tenant_id', 't-1'],
      ['user_id', 'u-1'],
    ]);
  });

  it('PATCH saves the mutes under the version read, keeping a hidden one', async () => {
    const { sb, calls } = prefsDb([
      { data: ROW(['leads']) },
      { data: ROW(['leads', 'maintenance'], 5) },
    ]);
    const res = await call('PATCH', 'seo', sb, { version: 4, maintenance: false });
    expect(res.status).toBe(200);
    expect(res.json.data).toEqual({ version: 5, maintenance: false, releases: true });
    expect(calls[1]).toMatchObject({
      op: 'update',
      payload: { notifications: { muted: ['leads', 'maintenance'] } },
      filters: [
        ['tenant_id', 't-1'],
        ['user_id', 'u-1'],
        ['version', 4],
      ],
    });
  });

  it('a first save (version 0, no row) inserts the person’s row', async () => {
    const { sb, calls } = prefsDb([{ data: null }, { data: ROW(['scheduled'], 1) }]);
    const res = await call('PATCH', 'content_creator', sb, { version: 0, scheduled: false });
    expect(res.status).toBe(200);
    expect(calls[1]).toMatchObject({
      op: 'insert',
      payload: { tenant_id: 't-1', user_id: 'u-1', notifications: { muted: ['scheduled'] } },
    });
  });

  it('a stale version is a 409 and writes nothing', async () => {
    const { sb, calls } = prefsDb([{ data: ROW([], 6) }]);
    const res = await call('PATCH', 'admin', sb, { version: 4, leads: false });
    expect(res.status).toBe(409);
    expect(calls).toHaveLength(1);
  });

  it('a kind the role’s bell never shows is a 422 and writes nothing', async () => {
    const { sb, calls } = prefsDb([{ data: ROW([]) }]);
    const res = await call('PATCH', 'content_creator', sb, { version: 4, leads: false });
    expect(res.status).toBe(422);
    expect(calls).toHaveLength(1);
  });

  it('a body that is not switches is a 422 before anything is read', async () => {
    const { sb, calls } = prefsDb([]);
    const res = await call('PATCH', 'admin', sb, { version: 4, email: false });
    expect(res.status).toBe(422);
    expect(calls).toHaveLength(0);
  });

  it('the save error classes are the shared ones (the route maps them)', () => {
    expect(new OptimisticLockError('admin_user_prefs').status).toBe(409);
    expect(new ValidationError('x').status).toBe(422);
  });
});
