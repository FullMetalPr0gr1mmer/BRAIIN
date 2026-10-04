import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import type { AuthContext, Role } from '@/lib/auth/types';
import { visibleNav } from '@/lib/admin/nav';
import { initialsOf, loadShellState } from '@/lib/admin/shell';

// The admin shell's state (Admin v2 F2): head counts beside sidebar links, the
// maintenance badge, the signed-in name. A count is computed only for a link the role
// sees, so a role never learns a number its menu would not show, and a failed read
// leaves its item out instead of breaking the page.

type Result = { count?: number | null; data?: unknown; error?: unknown };

function fakeSupabase(results: Record<string, Result>) {
  const tables: string[] = [];
  const sb = {
    from(table: string) {
      tables.push(table);
      const result = results[table] ?? {};
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: () =>
          Promise.resolve({ data: result.data ?? null, error: result.error ?? null }),
        then: (resolve: (value: unknown) => unknown) =>
          resolve({ count: result.count ?? null, error: result.error ?? null }),
      };
      return builder;
    },
  };
  return { sb: sb as unknown as SupabaseClient, tables };
}

const auth = (role: Role): AuthContext => ({
  userId: 'u-1',
  tenantId: 't-1',
  role,
  isActive: true,
  email: 'someone@example.com',
});

const kv = (value: string | null) => ({
  SESSION: { get: async () => value } as unknown as KVNamespace,
});

describe('loadShellState', () => {
  it('counts new leads and applications for Admin, who sees both links', async () => {
    const { sb, tables } = fakeSupabase({
      leads: { count: 4 },
      job_applications: { count: 2 },
      profiles: { data: { display_name: 'Kareem Hassan' } },
    });
    const state = await loadShellState(sb, auth('admin'), visibleNav('admin'), kv(null));
    expect(state.counts).toEqual({ leads: 4, applications: 2 });
    expect(state.displayName).toBe('Kareem Hassan');
    expect(tables).toEqual(expect.arrayContaining(['leads', 'job_applications']));
  });

  it('never queries a count a role has no link for', async () => {
    const { sb, tables } = fakeSupabase({ leads: { count: 4 }, job_applications: { count: 2 } });
    const state = await loadShellState(
      sb,
      auth('content_creator'),
      visibleNav('content_creator'),
      kv(null),
    );
    expect(state.counts).toEqual({});
    expect(tables).not.toContain('leads');
    expect(tables).not.toContain('job_applications');
  });

  it('gives Developer the lead count but not the applications one', async () => {
    const { sb, tables } = fakeSupabase({ leads: { count: 1 }, job_applications: { count: 9 } });
    const state = await loadShellState(sb, auth('developer'), visibleNav('developer'), kv(null));
    expect(state.counts).toEqual({ leads: 1 });
    expect(tables).not.toContain('job_applications');
  });

  it('leaves out a count whose read failed', async () => {
    const { sb } = fakeSupabase({
      leads: { error: { message: 'down' } },
      job_applications: { count: 3 },
    });
    const state = await loadShellState(sb, auth('admin'), visibleNav('admin'), kv(null));
    expect(state.counts).toEqual({ applications: 3 });
  });

  it('reads the maintenance flag, and treats a broken value as off', async () => {
    const { sb } = fakeSupabase({});
    const on = await loadShellState(sb, auth('seo'), visibleNav('seo'), kv('{"active":true}'));
    expect(on.maintenance).toBe(true);
    const broken = await loadShellState(sb, auth('seo'), visibleNav('seo'), kv('not json'));
    expect(broken.maintenance).toBe(false);
  });
});

describe('initialsOf', () => {
  it('takes the first and last word of a name, else the e-mail', () => {
    expect(initialsOf('Kareem Hassan Ali', 'k@example.com')).toBe('KA');
    expect(initialsOf('Sara', 's@example.com')).toBe('SA');
    expect(initialsOf(null, 'e2e-admin@example.com')).toBe('E2');
    expect(initialsOf('  ', 'dev@example.com')).toBe('DE');
  });
});
