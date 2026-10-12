import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIRoute } from 'astro';
import AccountDrawer from '@/components/admin/screens/chrome/AccountDrawer';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ROLES, type AuthContext, type Role } from '@/lib/auth/types';
import { CAPABILITIES, ROLE_CAPS } from '@/lib/authz/matrix';
import { AuthorizationError } from '@/lib/authz/errors';
import { CAP_LABELS, ROLE_LABELS, capLinesFor } from '@/lib/authz/capLabels';
import { UserInviteSchema, UserUpdateSchema } from '@schemas/admin';
import {
  AdminPrefsPutSchema,
  DISPLAY_NAME_MAX,
  DISPLAY_NAME_REFUSED,
  DisplayNameSchema,
  DisplayNameValueSchema,
  NotificationPrefsSchema,
  PasswordChangeSchema,
  readNotificationPrefs,
} from '@schemas/adminPrefs';
import { OptimisticLockError, ValidationError } from '@/lib/admin/errors';
import {
  markNotificationsSeen,
  readMyPrefs,
  saveMyNotificationPrefs,
  seenUpTo,
} from '@/lib/admin/prefs';
import {
  ENVIRONMENT_LABELS,
  adminEnvironment,
  resetEnvironmentCache,
} from '@/lib/admin/environment';
import { accountViewFor, updateMyDisplayName } from '@/lib/admin/account';
import { getMaintenanceState, putMaintenanceState } from '@/lib/http/maintenance';

// The personal layer's smaller parts (Admin v2 F8, docs/admin-v2/ui.md AV-05): the
// preferences row under its optimistic lock, the environment pill's per-isolate cache,
// "What you can do" from ROLE_CAPS, the account schemas, renaming yourself, and the
// maintenance switch's `changedAt` stamp the bell reads. The bell's per-role rules are in
// notifications.spec.ts, the password change in accountPassword.spec.ts, and what the
// database allows in supabase/tests/personal_layer.test.sql.

const audits = vi.hoisted(() => [] as { action: string; detail?: Record<string, unknown> }[]);
vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));
vi.mock('@/lib/admin/audit', () => ({
  writeAudit: async (_sb: unknown, _ctx: unknown, entry: (typeof audits)[number]) => {
    audits.push(entry);
    return true;
  },
}));

const TENANT = 't-1';
const USER = 'u-1';
const auth = (role: Role = 'seo'): AuthContext => ({
  userId: USER,
  tenantId: TENANT,
  role,
  isActive: true,
  email: 'sam@example.test',
});

beforeEach(() => {
  audits.length = 0;
});

// ── Preferences ────────────────────────────────────────────────────────────────

interface Call {
  op: 'select' | 'insert' | 'update';
  payload?: unknown;
  filters: [string, unknown][];
}

/** admin_user_prefs as a queue of answers, one per statement, recording each statement. */
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

const ROW = {
  notifications: { muted: ['scheduled', 'not-a-kind'] },
  notifications_seen_at: '2026-10-10T09:00:00.000Z',
  version: 4,
};

describe('preferences', () => {
  it('a person with no row reads the defaults at version 0', async () => {
    const { sb, calls } = prefsDb([{ data: null }]);
    expect(await readMyPrefs(sb, auth())).toEqual({
      version: 0,
      notifications: { muted: [] },
      notificationsSeenAt: null,
    });
    expect(calls[0]!.filters).toEqual([
      ['tenant_id', TENANT],
      ['user_id', USER],
    ]);
  });

  it('a stored kind this build does not know is dropped on read', async () => {
    const { sb } = prefsDb([{ data: ROW }]);
    expect((await readMyPrefs(sb, auth())).notifications).toEqual({ muted: ['scheduled'] });
  });

  it('the first save inserts the row as the person; a row made in another tab is a 409', async () => {
    const created = prefsDb([{ data: { ...ROW, version: 1 } }]);
    await saveMyNotificationPrefs(created.sb, auth(), 0, { muted: ['leads'] });
    expect(created.calls[0]).toMatchObject({
      op: 'insert',
      payload: { tenant_id: TENANT, user_id: USER, notifications: { muted: ['leads'] } },
    });

    const raced = prefsDb([{ error: { code: '23505', message: 'duplicate key' } }]);
    await expect(
      saveMyNotificationPrefs(raced.sb, auth(), 0, { muted: [] }),
    ).rejects.toBeInstanceOf(OptimisticLockError);
  });

  it('a later save is checked against the version read; a stale one is a 409, never an overwrite', async () => {
    const saved = prefsDb([{ data: { ...ROW, version: 5 } }]);
    const prefs = await saveMyNotificationPrefs(saved.sb, auth(), 4, { muted: ['scheduled'] });
    expect(prefs.version).toBe(5);
    expect(saved.calls[0]).toMatchObject({
      op: 'update',
      payload: { notifications: { muted: ['scheduled'] } },
      filters: [
        ['tenant_id', TENANT],
        ['user_id', USER],
        ['version', 4],
      ],
    });

    const stale = prefsDb([{ data: null }]);
    await expect(
      saveMyNotificationPrefs(stale.sb, auth(), 3, { muted: [] }),
    ).rejects.toBeInstanceOf(OptimisticLockError);
  });

  it('"Mark all as read" moves the watermark only: no version is sent or checked', async () => {
    const { sb, calls } = prefsDb([
      { data: { notifications_seen_at: '2026-10-10T12:00:00.000Z' } },
    ]);
    const at = new Date('2026-10-10T12:00:00.000Z');
    expect(await markNotificationsSeen(sb, auth(), at)).toBe('2026-10-10T12:00:00.000Z');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      op: 'update',
      payload: { notifications_seen_at: at.toISOString() },
      filters: [
        ['tenant_id', TENANT],
        ['user_id', USER],
      ],
    });
  });

  it('marking read with no row creates it; a row made meanwhile is updated instead', async () => {
    const at = new Date('2026-10-10T12:00:00.000Z');
    const created = prefsDb([
      { data: null },
      { data: { notifications_seen_at: '2026-10-10T12:00:00.000Z' } },
    ]);
    await markNotificationsSeen(created.sb, auth(), at);
    expect(created.calls.map((c) => c.op)).toEqual(['update', 'insert']);
    expect(created.calls[1]!.payload).toMatchObject({
      tenant_id: TENANT,
      user_id: USER,
      notifications_seen_at: at.toISOString(),
    });

    const raced = prefsDb([
      { data: null },
      { error: { code: '23505', message: 'duplicate key' } },
      { data: { notifications_seen_at: '2026-10-10T12:00:00.000Z' } },
    ]);
    expect(await markNotificationsSeen(raced.sb, auth(), at)).toBe('2026-10-10T12:00:00.000Z');
    expect(raced.calls.map((c) => c.op)).toEqual(['update', 'insert', 'update']);
  });

  it('marks up to when the list was read, held to now: never the time of the click', () => {
    const now = Date.parse('2026-10-10T12:00:00.000Z');
    expect(seenUpTo('2026-10-10T11:58:30.000Z', now).toISOString()).toBe(
      '2026-10-10T11:58:30.000Z',
    );
    // A list "read" in the future (a clock ahead, or a forged value) marks no further than now.
    expect(seenUpTo('2026-10-11T00:00:00.000Z', now).toISOString()).toBe(
      '2026-10-10T12:00:00.000Z',
    );
  });

  it('POST /api/admin/notifications/seen stores the list time it is sent, and needs one', async () => {
    const { POST } = (await import('@/pages/api/admin/notifications/seen')) as {
      POST: APIRoute;
    };
    async function post(body: unknown) {
      const { sb, calls } = prefsDb([
        { data: { notifications_seen_at: '2026-10-10T11:58:30.000Z' } },
      ]);
      const request = new Request('https://admin.example.test/api/admin/notifications/seen', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const res = await POST({
        locals: { session: auth('content_creator'), supabase: sb },
        request,
        url: new URL(request.url),
        params: {},
      } as unknown as Parameters<APIRoute>[0]);
      return { status: res.status, calls };
    }

    // The drawer loaded its list at 11:58:30; a lead arriving at 11:59 was never shown.
    const marked = await post({ asOf: '2026-10-10T11:58:30.000Z' });
    expect(marked.status).toBe(200);
    expect(marked.calls[0]).toMatchObject({
      op: 'update',
      payload: { notifications_seen_at: '2026-10-10T11:58:30.000Z' },
    });

    for (const body of [{}, { asOf: 'yesterday' }, { asOf: '2026-10-10T11:58:30Z', x: 1 }]) {
      const refused = await post(body);
      expect(refused.status, JSON.stringify(body)).toBe(422);
      expect(refused.calls, JSON.stringify(body)).toEqual([]);
    }
  });
});

// ── The environment pill ─────────────────────────────────────────────────────────

function envDb(answer: { data?: unknown; error?: unknown } | 'throw') {
  const rpc = vi.fn(async () => {
    if (answer === 'throw') throw new Error('network');
    return { data: answer.data ?? null, error: answer.error ?? null };
  });
  return { sb: { rpc } as unknown as SupabaseClient, rpc };
}

describe('the environment pill', () => {
  beforeEach(() => resetEnvironmentCache());

  it('names only what the marker says, in plain words', async () => {
    expect(ENVIRONMENT_LABELS).toEqual({ production: 'Live', staging: 'Staging', local: 'Local' });
    for (const value of ['production', 'staging', 'local'] as const) {
      resetEnvironmentCache();
      expect(await adminEnvironment(envDb({ data: value }).sb, TENANT)).toBe(value);
    }
    for (const answer of [{ data: null }, { data: 'development' }, { error: { message: 'x' } }]) {
      resetEnvironmentCache();
      expect(await adminEnvironment(envDb(answer).sb, TENANT)).toBeNull();
    }
    resetEnvironmentCache();
    expect(await adminEnvironment(envDb('throw').sb, TENANT)).toBeNull();
  });

  it('asks with the tenant, then keeps a known answer ten minutes', async () => {
    const { sb, rpc } = envDb({ data: 'staging' });
    await adminEnvironment(sb, TENANT, 0);
    expect(rpc).toHaveBeenCalledWith('admin_environment', { p_tenant: TENANT });
    await adminEnvironment(sb, TENANT, 9 * 60_000);
    expect(rpc).toHaveBeenCalledTimes(1);
    await adminEnvironment(sb, TENANT, 10 * 60_000 + 1);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('never keeps "no answer": it can be the caller\'s, not the database\'s', async () => {
    // admin_environment answers NULL to a caller who is not live: a token locked a moment
    // ago (a fifth wrong password) must not hide the pill from everyone on the isolate.
    const locked = envDb({ data: null });
    await adminEnvironment(locked.sb, TENANT, 0);
    expect(await adminEnvironment(envDb({ data: 'production' }).sb, TENANT, 1_000)).toBe(
      'production',
    );

    resetEnvironmentCache();
    const failing = envDb('throw');
    await adminEnvironment(failing.sb, TENANT, 0);
    await adminEnvironment(failing.sb, TENANT, 1_000);
    expect(failing.rpc).toHaveBeenCalledTimes(2);
  });
});

// ── The chrome drawers, rendered on the server on every admin page ─────────────────

describe('the account drawer on the server', () => {
  it('is an empty dialog until it is opened: no forms, no capability lines', () => {
    const html = renderToStaticMarkup(
      createElement(AccountDrawer, { view: accountViewFor(auth('admin'), 'Sam Example') }),
    );
    expect(html).toContain('Your account');
    expect(html).not.toContain('Change password');
    expect(html).not.toContain('acct__can');
    for (const line of capLinesFor('admin')) expect(html).not.toContain(line);
  });
});

// ── "What you can do" ────────────────────────────────────────────────────────────

describe('CAP_LABELS', () => {
  it('names every capability, and every partial level a role holds', () => {
    expect(Object.keys(CAP_LABELS).sort()).toEqual([...CAPABILITIES].sort());
    for (const role of ROLES) {
      for (const cap of CAPABILITIES) {
        const access = ROLE_CAPS[role][cap];
        if (access === 'view') expect(CAP_LABELS[cap].view, `${role} ${cap}`).toBeTruthy();
        if (access === 'meta') expect(CAP_LABELS[cap].meta, `${role} ${cap}`).toBeTruthy();
      }
    }
  });

  it('one line per capability a role holds, and none it does not', () => {
    for (const role of ROLES) {
      const held = CAPABILITIES.filter((cap) => ROLE_CAPS[role][cap] !== 'none');
      expect(capLinesFor(role), role).toHaveLength(held.length);
    }
    expect(capLinesFor('admin')).toHaveLength(CAPABILITIES.length);
    // The partial levels read as what they allow, not as the full right.
    expect(capLinesFor('content_creator')).toContain(CAP_LABELS['seo.entityMeta'].view);
    expect(capLinesFor('content_creator')).not.toContain(CAP_LABELS['seo.entityMeta'].full);
    expect(capLinesFor('seo')).toContain(CAP_LABELS['media.write'].meta);
    expect(capLinesFor('developer')).not.toContain(CAP_LABELS['content.publish'].full);
  });

  it('follows the copy rules: no em or en dash (README P-12)', () => {
    const copy = [
      ...Object.values(CAP_LABELS).flatMap((l) => [l.full, l.view ?? '', l.meta ?? '']),
      ...Object.values(ROLE_LABELS),
    ];
    for (const line of copy) expect(line, line).not.toMatch(/[–—]/);
    expect(Object.keys(ROLE_LABELS).sort()).toEqual([...ROLES].sort());
  });

  it('the account view ships lines and a name, never the capability map', () => {
    const view = accountViewFor(auth('seo'), 'Sam Example');
    expect(view).toMatchObject({ role: 'SEO', initials: 'SE', displayName: 'Sam Example' });
    expect(view.can).toEqual(capLinesFor('seo'));
    expect(JSON.stringify(view)).not.toMatch(/"(leads|seo|media)\.[a-zA-Z]+"/);
    expect(view.accessNote).toBe('Ask an Admin to change your access.');
    expect(accountViewFor(auth('admin'), null).accessNote).toContain('Users & roles');
    expect(accountViewFor(auth('admin'), null).initials).toBe('SA');
  });
});

// ── The account schemas ──────────────────────────────────────────────────────────

describe('the account schemas', () => {
  it('a display name is trimmed, at most 80 characters, and may be cleared', () => {
    expect(DisplayNameSchema.parse({ display_name: '  Sam  ' })).toEqual({ display_name: 'Sam' });
    expect(DisplayNameSchema.parse({ display_name: '   ' })).toEqual({ display_name: '' });
    expect(DisplayNameSchema.parse({ display_name: 'سارة الأحمد' }).display_name).toBe(
      'سارة الأحمد',
    );
    expect(DisplayNameSchema.safeParse({ display_name: 'x'.repeat(81) }).success).toBe(false);
  });

  it('a display name cannot carry a control or bidi formatting character', () => {
    for (const bad of ['a\tb', 'a\u0000b', 'evil\u202Etxt', 'a\u200Fb']) {
      expect(DisplayNameSchema.safeParse({ display_name: bad }).success, JSON.stringify(bad)).toBe(
        false,
      );
    }
    expect(DisplayNameSchema.safeParse({ display_name: 'Sam', role: 'admin' }).success).toBe(false);
  });

  it("the users screen's schemas hold a colleague's name to the same rule", () => {
    const userId = '00000000-0000-4000-8000-000000000001';
    for (const bad of ['x'.repeat(81), 'evil\u202Etxt', 'Am\u200Bal', 'a\u2066b']) {
      const label = JSON.stringify(bad);
      expect(DisplayNameValueSchema.safeParse(bad).success, label).toBe(false);
      expect(
        UserInviteSchema.safeParse({ email: 'new@example.test', role: 'seo', displayName: bad })
          .success,
        label,
      ).toBe(false);
      expect(UserUpdateSchema.safeParse({ userId, displayName: bad }).success, label).toBe(false);
    }
    expect(UserUpdateSchema.parse({ userId, displayName: '  Sam  ' }).displayName).toBe('Sam');
    expect(DisplayNameValueSchema.parse('x'.repeat(DISPLAY_NAME_MAX))).toHaveLength(80);
  });

  it('PATCH /api/admin/users/[id] refuses a bidi override before it reaches the database', async () => {
    const { PATCH } = (await import('@/pages/api/admin/users/[id]')) as { PATCH: APIRoute };
    const id = '00000000-0000-4000-8000-000000000002';
    const request = new Request(`https://admin.example.test/api/admin/users/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'nimda\u202Etxt' }),
    });
    const from = vi.fn(() => {
      throw new Error('the database must not be reached');
    });
    const res = await PATCH({
      locals: { session: auth('admin'), supabase: { from } as unknown as SupabaseClient },
      request,
      url: new URL(request.url),
      params: { id },
    } as unknown as Parameters<APIRoute>[0]);
    expect(res.status).toBe(422);
    expect(from).not.toHaveBeenCalled();
  });

  it('a new password is at least 10 characters and at most 72 bytes, typed twice, and new', () => {
    const ok = { current: 'old-password', next: 'long-enough-1', confirm: 'long-enough-1' };
    expect(PasswordChangeSchema.safeParse(ok).success).toBe(true);
    expect(PasswordChangeSchema.safeParse({ ...ok, next: 'short', confirm: 'short' }).success).toBe(
      false,
    );
    const wide = 'é'.repeat(37); // 74 bytes, 37 characters
    expect(PasswordChangeSchema.safeParse({ ...ok, next: wide, confirm: wide }).success).toBe(
      false,
    );
    const mismatch = PasswordChangeSchema.safeParse({ ...ok, confirm: 'something-else' });
    expect(mismatch.success).toBe(false);
    expect(mismatch.error?.issues[0]?.path).toEqual(['confirm']);
    const same = PasswordChangeSchema.safeParse({
      current: ok.next,
      next: ok.next,
      confirm: ok.next,
    });
    expect(same.error?.issues[0]?.path).toEqual(['next']);
  });

  it('preferences: known kinds only, each once; the dashboard waits for its own slice', () => {
    expect(NotificationPrefsSchema.parse({ muted: ['leads', 'leads'] })).toEqual({
      muted: ['leads'],
    });
    expect(NotificationPrefsSchema.safeParse({ muted: ['everything'] }).success).toBe(false);
    expect(
      AdminPrefsPutSchema.safeParse({ version: 1, notifications: { muted: [] }, dashboard: {} })
        .success,
    ).toBe(false);
    expect(readNotificationPrefs('garbage')).toEqual({ muted: [] });
    expect(readNotificationPrefs({ muted: ['maintenance', 7, null] })).toEqual({
      muted: ['maintenance'],
    });
  });
});

// ── Renaming yourself ────────────────────────────────────────────────────────────

describe('renaming yourself', () => {
  function rpcDb(answer: { data?: unknown; error?: { code: string; message: string } }) {
    const rpc = vi.fn(async () => ({ data: answer.data ?? null, error: answer.error ?? null }));
    return { sb: { rpc } as unknown as SupabaseClient, rpc };
  }

  it('calls update_my_profile with the tenant and the name, and returns what was stored', async () => {
    const { sb, rpc } = rpcDb({ data: 'Sam Example' });
    expect(await updateMyDisplayName(sb, auth(), 'Sam Example')).toBe('Sam Example');
    expect(rpc).toHaveBeenCalledWith('update_my_profile', {
      p_tenant: TENANT,
      p_display_name: 'Sam Example',
    });
    expect(await updateMyDisplayName(rpcDb({ data: null }).sb, auth(), '')).toBeNull();
  });

  it("maps the database's refusals: 22023 a bad name (422), 42501 not a live member (403)", async () => {
    await expect(
      updateMyDisplayName(rpcDb({ error: { code: '22023', message: 'x' } }).sb, auth(), 'x'),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      updateMyDisplayName(rpcDb({ error: { code: '42501', message: 'x' } }).sb, auth(), 'x'),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('PATCH /api/admin/me leaves the audit row to the database: it writes no second one', async () => {
    const { PATCH } = (await import('@/pages/api/admin/me/index')) as { PATCH: APIRoute };
    const request = new Request('https://admin.example.test/api/admin/me', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ display_name: 'Secret Agent Name' }),
    });
    const { sb, rpc } = rpcDb({ data: 'Secret Agent Name' });
    const res = await PATCH({
      locals: { session: auth('developer'), supabase: sb },
      request,
      url: new URL(request.url),
      params: {},
    } as unknown as Parameters<APIRoute>[0]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { display_name: 'Secret Agent Name' } });
    // update_my_profile writes `profile.update` (the field's name only) in its own
    // transaction (0044, pgTAP personal_layer.test.sql); the route adds nothing.
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(audits).toEqual([]);
  });
});

// ── The database's name rules are the schema's ───────────────────────────────────

describe("the database's name rule is the schema's, for every writer (0044)", () => {
  const sql = readFileSync(
    join(process.cwd(), 'supabase/migrations/0044_personal_layer.sql'),
    'utf8',
  );
  const at = (marker: string) => {
    const index = sql.indexOf(marker);
    expect(index, marker).toBeGreaterThanOrEqual(0);
    return index;
  };
  const rule = sql.slice(
    at('create or replace function app.display_name_ok'),
    at('create or replace function app.tg_profiles_display_name'),
  );
  const trigger = sql.slice(
    at('create or replace function app.tg_profiles_display_name'),
    at('create or replace function public.update_my_profile'),
  );
  const definition = sql.slice(
    sql.lastIndexOf('create or replace function public.update_my_profile'),
  );
  const hex = (cp: number) => cp.toString(16).toUpperCase().padStart(4, '0');
  const isSurrogate = (cp: number) => cp >= 0xd800 && cp <= 0xdfff;

  /** `\uXXXX` / `\UXXXXXXXX` escapes and ranges between them, every character accounted for. */
  function codePointRanges(source: string): [number, number][] {
    const escape = String.raw`\\u([0-9A-F]{4})|\\U([0-9A-F]{8})`;
    const item = new RegExp(`(?:${escape})(?:-(?:${escape}))?`, 'gy');
    const ranges: [number, number][] = [];
    let consumed = 0;
    for (const m of source.matchAll(item)) {
      const from = parseInt(m[1] ?? m[2] ?? '', 16);
      const end = m[3] ?? m[4];
      const to = end ? parseInt(end, 16) : from;
      ranges.push([from, to]);
      consumed += m[0].length;
    }
    expect(consumed, 'every character of the SQL set is an escape or a range').toBe(source.length);
    return ranges;
  }
  const within = (ranges: [number, number][], cp: number) =>
    ranges.some(([from, to]) => cp >= from && cp <= to);

  it('trims exactly what JavaScript trim() trims', () => {
    const source = /btrim\(coalesce\(p_display_name, ''\),\s*E'([^']*)'\)/.exec(definition)?.[1];
    expect(source, 'the trim set in update_my_profile').toBeTruthy();
    const trimmed = codePointRanges(source!);
    const mismatches: string[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp += 1) {
      if (isSurrogate(cp)) continue;
      const js = String.fromCodePoint(cp).trim() === '';
      if (js !== within(trimmed, cp)) mismatches.push(hex(cp));
    }
    expect(mismatches).toEqual([]);
  });

  it('refuses exactly the control and format characters the schema refuses', () => {
    const source = /p_name !~ '\[([^'\]]*)\]'/.exec(rule)?.[1];
    expect(source, 'the refused class in app.display_name_ok').toBeTruthy();
    const refused = codePointRanges(source!);
    const mismatches: string[] = [];
    // From 1: NUL cannot reach a text value (Postgres refuses it), so the class omits it.
    for (let cp = 1; cp <= 0x10ffff; cp += 1) {
      if (isSurrogate(cp)) continue;
      const js = DISPLAY_NAME_REFUSED.test(String.fromCodePoint(cp));
      if (js !== within(refused, cp)) mismatches.push(hex(cp));
    }
    // A new Unicode version that adds a format character fails here: add it to the class.
    expect(mismatches).toEqual([]);
  });

  it('allows exactly DISPLAY_NAME_MAX characters, and no name at all', () => {
    expect(/char_length\(p_name\) <= (\d+)/.exec(rule)?.[1]).toBe(String(DISPLAY_NAME_MAX));
    expect(rule).toMatch(/select p_name is null\s+or \(/);
  });

  it('holds the rename and every other writer of profiles.display_name to it', () => {
    // The rename refuses before it writes (22023); the trigger holds every other writer,
    // the users screen's Admin session and the service role included (23514), when a name
    // is written and changes.
    expect(definition).toMatch(
      /if not app\.display_name_ok\(v_name\) then\s+raise exception using errcode = '22023'/,
    );
    expect(trigger).toMatch(
      /if new\.display_name is not distinct from old\.display_name then\s+return new;/,
    );
    expect(trigger).toMatch(
      /if not app\.display_name_ok\(new\.display_name\) then\s+raise exception using errcode = '23514'/,
    );
    expect(sql).toMatch(
      /create trigger profiles_display_name_rule before insert or update of display_name on public\.profiles\s+for each row execute function app\.tg_profiles_display_name\(\);/,
    );
  });

  it('writes its own audit row, with the field name and never the name', () => {
    expect(definition).toMatch(
      /insert into public\.audit_log \(tenant_id, actor_id, actor_role, action, entity_type, entity_id, detail\)\s*values \(p_tenant, v_uid, v_role, 'profile\.update', 'profile', v_uid::text,\s*jsonb_build_object\('fields', jsonb_build_array\('display_name'\)\)\);/,
    );
  });
});

// ── The maintenance switch's stamp (the bell's "turned on/off") ────────────────────

function kv() {
  const store = new Map<string, string>();
  return {
    store,
    env: {
      SESSION: {
        get: async (key: string) => store.get(key) ?? null,
        put: async (key: string, value: string) => void store.set(key, value),
      },
    } as unknown as Parameters<typeof putMaintenanceState>[0],
  };
}

describe('the maintenance snapshot carries when it last flipped', () => {
  it('round-trips changedAt, and drops a value that is not a time', async () => {
    const { env, store } = kv();
    await putMaintenanceState(env, {
      active: true,
      allowlist: ['203.0.113.9'],
      changedAt: '2026-10-10T08:00:00.000Z',
    });
    expect(await getMaintenanceState(env)).toEqual({
      active: true,
      allowlist: ['203.0.113.9'],
      changedAt: '2026-10-10T08:00:00.000Z',
    });

    store.set(
      'site:maintenance',
      JSON.stringify({ active: false, allowlist: [], changedAt: 'soon' }),
    );
    expect(await getMaintenanceState(env)).toEqual({ active: false, allowlist: [] });
    store.set('site:maintenance', JSON.stringify({ active: true, allowlist: [] }));
    expect(await getMaintenanceState(env)).toEqual({ active: true, allowlist: [] });
  });

  async function patchMaintenance(stored: unknown, body: Record<string, unknown>) {
    const writes: unknown[] = [];
    const sb = {
      from: () => {
        const b: Record<string, unknown> = {};
        for (const m of ['select', 'eq']) b[m] = () => b;
        b['update'] = (payload: unknown) => {
          writes.push(payload);
          return b;
        };
        let reads = 0;
        b['maybeSingle'] = async () =>
          reads++ === 0 && writes.length === 0
            ? { data: { version: 2, maintenance: stored }, error: null }
            : { data: { version: 3 }, error: null };
        return b;
      },
    };
    const { PATCH } = (await import('@/pages/api/admin/settings/maintenance')) as {
      PATCH: APIRoute;
    };
    const request = new Request('https://admin.example.test/api/admin/settings/maintenance', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 2, allowlist: [], ...body }),
    });
    const res = await PATCH({
      locals: { session: auth('developer'), supabase: sb },
      request,
      url: new URL(request.url),
      params: {},
    } as unknown as Parameters<APIRoute>[0]);
    expect(res.status).toBe(200);
    return (writes[0] as { maintenance: Record<string, unknown> }).maintenance;
  }

  it('turning it on stamps now; changing only the allowlist keeps the stamp', async () => {
    const before = Date.now();
    const on = await patchMaintenance({ active: false, allowlist: [] }, { active: true });
    expect(Date.parse(String(on['changedAt']))).toBeGreaterThanOrEqual(before);

    const kept = await patchMaintenance(
      { active: true, allowlist: [], changedAt: '2026-10-09T08:00:00.000Z' },
      { active: true, allowlist: ['203.0.113.9'] },
    );
    expect(kept['changedAt']).toBe('2026-10-09T08:00:00.000Z');
  });

  it('a switch never recorded is not given an invented time', async () => {
    const unknown = await patchMaintenance({ active: false, allowlist: [] }, { active: false });
    expect(unknown).not.toHaveProperty('changedAt');
  });
});
