import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AstroCookies } from 'astro';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ROLES, type AuthContext, type Role } from '@/lib/auth/types';

// The no-JS pages' forms (Admin v2 F8): /admin/account (rename, password, sign out) and
// /admin/notifications ("Mark all as read"). Each page answers 403 to anyone but an active
// member before reading the form, then hands it to src/lib/admin/personalForms.ts, which
// answers what the JSON route for the same action answers: a refused name 422, a session
// that may no longer rename 403, a wrong current password 422 and the fifth 423, an auth
// server that cannot answer 502; a success redirects (303). The lockout's counting is SQL
// (0009), stubbed with its contract as in accountPassword.spec.ts.

const state = vi.hoisted(() => ({
  failures: new Map<string, number>(),
  audits: [] as { action: string; detail?: Record<string, unknown> }[],
}));

vi.mock('@/lib/supabase/server', () => ({
  serviceClient: () => ({
    rpc: async (fn: string, args: { p_email: string }) => {
      const failed = state.failures.get(args.p_email) ?? 0;
      if (fn === 'login_is_locked') return { data: failed >= 5, error: null };
      if (fn === 'register_failed_login') {
        state.failures.set(args.p_email, failed + 1);
        return { data: failed + 1 >= 5, error: null };
      }
      return { data: null, error: null };
    },
  }),
}));
vi.mock('@/lib/admin/audit', () => ({
  writeAudit: async (_sb: unknown, _ctx: unknown, entry: (typeof state.audits)[number]) => {
    state.audits.push(entry);
    return true;
  },
}));
vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));

const { accountFormPost, mayPostPersonalForm, notificationsFormPost, savedAccountFlash } =
  await import('@/lib/admin/personalForms');

const EMAIL = 'person@example.test';
const CURRENT = 'the-current-password-1';
const NEXT = 'a-brand-new-password-22';

const session = (role: Role = 'seo', isActive = true): AuthContext => ({
  userId: 'u-1',
  tenantId: 't-1',
  role,
  isActive,
  email: EMAIL,
});

interface DbOptions {
  /** update_my_profile's answer. */
  rename?: { data?: unknown; error?: { code: string; message: string } };
  /** What signInWithPassword answers whatever the password (the auth server failing). */
  signInError?: { code?: string; status?: number; message: string };
  /** admin_user_prefs answers with an error. */
  prefsError?: boolean;
}

/** The session client the pages hand over: rpc, auth and the preferences row. */
function fakeDb(options: DbOptions = {}) {
  const rpc = vi.fn(async (_fn: string, _args: unknown) => ({
    data: options.rename?.data ?? null,
    error: options.rename?.error ?? null,
  }));
  const calls: string[] = [];
  const writes: unknown[] = [];
  const sb = {
    rpc,
    from(table: string) {
      expect(table).toBe('admin_user_prefs');
      const builder: Record<string, unknown> = {
        update: (payload: unknown) => {
          writes.push(payload);
          return builder;
        },
        insert: (payload: unknown) => {
          writes.push(payload);
          return builder;
        },
        eq: () => builder,
        select: () => builder,
        maybeSingle: async () =>
          options.prefsError
            ? { data: null, error: { message: 'down' } }
            : { data: { notifications_seen_at: '2026-10-10T11:58:30.000Z' }, error: null },
      };
      return builder;
    },
    auth: {
      signInWithPassword: async ({ password }: { password: string }) => {
        calls.push('signIn');
        if (options.signInError) return { data: {}, error: options.signInError };
        return password === CURRENT
          ? { data: { user: {}, session: {} }, error: null }
          : {
              data: {},
              error: { code: 'invalid_credentials', status: 400, message: 'Invalid' },
            };
      },
      updateUser: async () => {
        calls.push('update');
        return { data: { user: {} }, error: null };
      },
      signOut: async (opts?: { scope?: string }) => {
        calls.push(`signOut:${opts?.scope ?? 'global'}`);
        return { error: null };
      },
    },
  };
  return { sb: sb as unknown as SupabaseClient, rpc, calls, writes };
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const cookies = () => ({ delete: vi.fn() });

function account(fields: Record<string, string>, db = fakeDb(), jar = cookies()) {
  return accountFormPost({
    sb: db.sb,
    session: session(),
    form: form(fields),
    cookies: jar as unknown as AstroCookies,
    ip: '203.0.113.7',
  });
}

beforeEach(() => {
  state.failures.clear();
  state.audits.length = 0;
});

describe('who may post the personal pages', () => {
  it('any active member, and nobody else', () => {
    for (const role of ROLES) expect(mayPostPersonalForm(session(role)), role).toBe(true);
    expect(mayPostPersonalForm(null)).toBe(false);
    expect(mayPostPersonalForm(session('admin', false))).toBe(false);
  });

  it('both pages answer 403 through it, before the form is read', () => {
    for (const page of ['src/pages/admin/account.astro', 'src/pages/admin/notifications.astro']) {
      const source = readFileSync(join(process.cwd(), page), 'utf8');
      expect(source, page).toMatch(
        /if \(!mayPostPersonalForm\(session\) \|\| !sb\) \{\s*return new Response\(null, \{ status: 403/,
      );
      expect(source.indexOf('mayPostPersonalForm(session)'), page).toBeLessThan(
        source.indexOf('formData()'),
      );
    }
  });
});

describe('/admin/account: renaming yourself', () => {
  it('saves through update_my_profile and redirects; the database writes the audit row', async () => {
    const db = fakeDb({ rename: { data: 'Sam Example' } });
    const result = await account({ intent: 'name', display_name: '  Sam Example ' }, db);
    expect(result).toEqual({ kind: 'redirect', location: '/admin/account?saved=name' });
    expect(db.rpc).toHaveBeenCalledWith('update_my_profile', {
      p_tenant: 't-1',
      p_display_name: 'Sam Example',
    });
    expect(state.audits).toEqual([]);
  });

  it('a name the schema refuses is a 422 beside the field, with what was typed', async () => {
    const db = fakeDb();
    const result = await account({ intent: 'name', display_name: 'x'.repeat(81) }, db);
    expect(result).toMatchObject({
      kind: 'render',
      status: 422,
      flash: { form: 'name', kind: 'error', field: 'display_name' },
      submittedName: 'x'.repeat(81),
    });
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("the database's refusals answer as the JSON route does: 422, 403, else 500", async () => {
    const answers: [{ code: string; message: string }, number][] = [
      [{ code: '22023', message: 'bad name' }, 422],
      [{ code: '42501', message: 'not live' }, 403],
      [{ code: 'XX000', message: 'boom' }, 500],
    ];
    for (const [error, status] of answers) {
      const result = await account(
        { intent: 'name', display_name: 'Sam' },
        fakeDb({ rename: { error } }),
      );
      expect(result, error.code).toMatchObject({ kind: 'render', status, submittedName: 'Sam' });
    }
  });
});

describe('/admin/account: changing your password', () => {
  const valid = { intent: 'password', current: CURRENT, next: NEXT, confirm: NEXT };

  it('a change redirects, says whether the other sessions ended, and is audited', async () => {
    const db = fakeDb();
    expect(await account(valid, db)).toEqual({
      kind: 'redirect',
      location: '/admin/account?saved=password',
    });
    expect(db.calls).toEqual(['signIn', 'update', 'signOut:others']);
    expect(state.audits.map((a) => a.action)).toEqual(['auth.password_change']);
  });

  it('a wrong current password is a 422 on that field, audited; the fifth is the 423', async () => {
    const wrong = { ...valid, current: 'wrong-password-99' };
    const first = await account(wrong);
    expect(first).toMatchObject({
      kind: 'render',
      status: 422,
      flash: { form: 'password', field: 'current' },
    });
    expect(state.audits.at(-1)).toMatchObject({
      action: 'auth.password_change_refused',
      detail: { reason: 'wrong-current' },
    });
    for (let i = 0; i < 3; i += 1) await account(wrong);
    expect(await account(wrong)).toMatchObject({ kind: 'render', status: 423 });
  });

  it('an auth server that cannot answer is a 502, as the JSON route answers, and counts nothing', async () => {
    const db = fakeDb({
      signInError: { code: 'over_request_rate_limit', status: 429, message: 'slow down' },
    });
    expect(await account(valid, db)).toMatchObject({
      kind: 'render',
      status: 502,
      flash: { form: 'password', kind: 'error' },
    });
    expect(state.failures.get(EMAIL)).toBeUndefined();
  });

  it('passwords the schema refuses are a 422 before anything is tried', async () => {
    const db = fakeDb();
    const result = await account({ ...valid, confirm: 'something-else-entirely' }, db);
    expect(result).toMatchObject({ kind: 'render', status: 422, flash: { field: 'confirm' } });
    expect(db.calls).toEqual([]);
  });

  it('never renders a password back', async () => {
    const results = [
      await account({ ...valid, current: 'wrong-password-99' }),
      await account({ ...valid, confirm: 'mismatch-mismatch' }),
    ];
    const text = JSON.stringify(results);
    for (const secret of [CURRENT, NEXT, 'wrong-password-99', 'mismatch-mismatch']) {
      expect(text).not.toContain(secret);
    }
  });
});

describe('/admin/account: signing out, and anything else', () => {
  it('signs out: an audit row, the session ended at the auth server, the cookie cleared', async () => {
    const db = fakeDb();
    const jar = cookies();
    expect(await account({ intent: 'signout' }, db, jar)).toEqual({
      kind: 'redirect',
      location: '/admin/login',
    });
    expect(state.audits.map((a) => a.action)).toEqual(['auth.logout']);
    expect(db.calls).toEqual(['signOut:global']);
    expect(jar.delete).toHaveBeenCalled();
  });

  it('a form this page does not render is a 400 that changes nothing', async () => {
    const db = fakeDb();
    expect(await account({ intent: 'role', role: 'admin' }, db)).toEqual({
      kind: 'render',
      status: 400,
      flash: null,
    });
    expect(db.rpc).not.toHaveBeenCalled();
    expect(db.calls).toEqual([]);
  });

  it('the notes after a redirect', () => {
    expect(savedAccountFlash('name')).toMatchObject({ form: 'name', kind: 'ok' });
    expect(savedAccountFlash('password')?.text).toContain('signed out on your other devices');
    expect(savedAccountFlash('password-here')?.text).toContain('could not be signed out');
    expect(savedAccountFlash(null)).toBeNull();
    expect(savedAccountFlash('anything')).toBeNull();
  });
});

describe('/admin/notifications: Mark all as read', () => {
  it('marks up to when the page read its list, then redirects', async () => {
    const db = fakeDb();
    const result = await notificationsFormPost({
      sb: db.sb,
      session: session('content_creator'),
      form: form({ intent: 'seen', as_of: '2026-10-10T11:58:30.000Z' }),
    });
    expect(result).toEqual({ kind: 'redirect', location: '/admin/notifications?done=seen' });
    expect(db.writes).toEqual([{ notifications_seen_at: '2026-10-10T11:58:30.000Z' }]);
  });

  it('a form without the list time, or not this page’s, is a 400 that writes nothing', async () => {
    for (const fields of [
      { intent: 'seen' },
      { intent: 'seen', as_of: 'now' },
      { as_of: '2026-10-10T11:58:30.000Z' },
    ]) {
      const db = fakeDb();
      const result = await notificationsFormPost({
        sb: db.sb,
        session: session(),
        form: form(fields),
      });
      expect(result, JSON.stringify(fields)).toEqual({
        kind: 'render',
        status: 400,
        flash: 'malformed',
      });
      expect(db.writes).toEqual([]);
    }
  });

  it('a watermark that cannot be saved is a 503', async () => {
    const result = await notificationsFormPost({
      sb: fakeDb({ prefsError: true }).sb,
      session: session(),
      form: form({ intent: 'seen', as_of: '2026-10-10T11:58:30.000Z' }),
    });
    expect(result).toEqual({ kind: 'render', status: 503, flash: 'unavailable' });
  });
});
