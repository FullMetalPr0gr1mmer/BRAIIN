import { MAINTENANCE_DEFAULTS } from '@schemas/maintenance';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import type { AuthContext, Role } from '@/lib/auth/types';
import { COUNTERS } from '@/lib/admin/counters';
import { ADMIN_NAV, visibleNav } from '@/lib/admin/nav';
import { initialsOf, loadShellState } from '@/lib/admin/shell';

// The admin shell's state (Admin v2 F2): head counts beside sidebar links, the
// maintenance badge, the signed-in name. A count is computed only for a link the role
// sees, so a role never learns a number its menu would not show, and a failed read
// leaves its item out instead of breaking the page.

type Result = {
  count?: number | null;
  data?: unknown;
  /** What a list query (awaited without maybeSingle) answers. */
  rows?: unknown[];
  error?: unknown;
};

interface Query {
  table: string;
  /** A HEAD count (`select(…, { head: true })`): no row leaves the database. */
  head: boolean;
  /** What it selected (an embedded table joins it). */
  columns?: string;
  filters: [string, unknown][];
}

function fakeSupabase(results: Record<string, Result>, rpc: Record<string, unknown> = {}) {
  const tables: string[] = [];
  const queries: Query[] = [];
  const sb = {
    from(table: string) {
      tables.push(table);
      const query: Query = { table, head: false, filters: [] };
      queries.push(query);
      const result = results[table] ?? {};
      const builder: Record<string, unknown> = {
        select: (columns?: string, options?: { head?: boolean }) => {
          query.head = options?.head === true;
          query.columns = columns ?? '';
          return builder;
        },
        eq: (column: string, value: unknown) => {
          query.filters.push([column, value]);
          return builder;
        },
        maybeSingle: () =>
          Promise.resolve({ data: result.data ?? null, error: result.error ?? null }),
        then: (resolve: (value: unknown) => unknown) =>
          resolve({
            count: result.count ?? null,
            data: result.rows ?? null,
            error: result.error ?? null,
          }),
      };
      for (const method of ['neq', 'gte', 'lt', 'order', 'limit', 'in'])
        builder[method] = () => builder;
      return builder;
    },
    rpc: async (fn: string) => ({ data: rpc[fn] ?? null, error: null }),
  };
  /** The filters of the HEAD counts on a table: the sidebar's counters. */
  const headFilters = (table: string) =>
    queries.filter((q) => q.table === table && q.head).map((q) => q.filters);
  return { sb: sb as unknown as SupabaseClient, tables, queries, headFilters };
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

  it("counts only the caller's tenant's NEW leads and applications, as the dashboard does", async () => {
    const { sb, headFilters, queries } = fakeSupabase({
      leads: { count: 4 },
      job_applications: { count: 2 },
    });
    await loadShellState(sb, auth('admin'), visibleNav('admin'), kv(null));
    // Leads (C4a): the pipeline's first stage, spam left out, the rule of the dashboard's
    // "New leads waiting" (lead_summary.new), not the legacy status.
    expect(headFilters('leads')).toEqual([
      [
        ['tenant_id', 't-1'],
        ['is_spam', false],
        ['lead_stages.is_initial', true],
      ],
    ]);
    expect(headFilters('job_applications')).toEqual([
      [
        ['tenant_id', 't-1'],
        ['status', 'new'],
      ],
    ]);
    expect(queries.filter((q) => q.table === 'profiles').map((q) => q.filters)).toEqual([
      [['id', 'u-1']],
    ]);
    // The stage is joined, inner, through the composite key (an outer join would count every
    // lead, whatever its stage).
    expect(queries.find((q) => q.table === 'leads' && q.head)?.columns).toBe(
      'id,lead_stages!inner(is_initial)',
    );
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

  it('takes the feed and the snapshot a page already read, and reads neither again', async () => {
    // /admin/notifications loads the whole feed for its list; the shell's dot and badge
    // come from that one read instead of a second run of the bell's loader.
    const { sb, tables } = fakeSupabase({ leads: { count: 4 }, job_applications: { count: 2 } });
    let kvReads = 0;
    const env = {
      SESSION: {
        get: async () => {
          kvReads += 1;
          return null;
        },
      } as unknown as KVNamespace,
    };
    const state = await loadShellState(sb, auth('admin'), visibleNav('admin'), env, {
      feed: { items: [], unread: 3, seenAt: null, failed: [], asOf: '2026-10-10T12:00:00.000Z' },
      maintenance: {
        active: true,
        allowlist: [],
        snapshot: { ...MAINTENANCE_DEFAULTS, active: true },
      },
    });
    expect(state.unread).toBe(3);
    expect(state.maintenance).toBe(true);
    expect(kvReads).toBe(0);
    // The bell's own reads (the person's watermark, the scheduled posts) never ran.
    expect(tables).not.toContain('admin_user_prefs');
    expect(tables).not.toContain('blog_posts');
    // The menu's counts are the shell's own, and still read.
    expect(state.counts).toEqual({ leads: 4, applications: 2 });
  });

  it('reads the maintenance flag, and treats a broken value as off', async () => {
    const { sb } = fakeSupabase({});
    const on = await loadShellState(sb, auth('seo'), visibleNav('seo'), kv('{"active":true}'));
    expect(on.maintenance).toBe(true);
    const broken = await loadShellState(sb, auth('seo'), visibleNav('seo'), kv('not json'));
    expect(broken.maintenance).toBe(false);
  });
});

describe('the release flag (Admin v2 R12: whether the savebar is drawn)', () => {
  /** A client that records every rpc and answers `releases_enabled` as given. */
  function flagClient(answer: { data?: unknown; error?: unknown }) {
    const { sb } = fakeSupabase({});
    const calls: { fn: string; args: unknown }[] = [];
    (sb as unknown as { rpc: unknown }).rpc = async (fn: string, args: unknown) => {
      calls.push({ fn, args });
      return fn === 'releases_enabled'
        ? { data: answer.data ?? null, error: answer.error ?? null }
        : { data: null, error: null };
    };
    return { sb, calls };
  }

  it('is read once, for the caller’s tenant, by every CMS role', async () => {
    for (const role of ['admin', 'content_creator', 'seo', 'developer'] as const) {
      const { sb, calls } = flagClient({ data: true });
      const state = await loadShellState(sb, auth(role), visibleNav(role), kv(null));
      expect(state.releases, role).toBe(true);
      expect(
        calls.filter((c) => c.fn === 'releases_enabled'),
        role,
      ).toEqual([{ fn: 'releases_enabled', args: { p_tenant: 't-1' } }]);
    }
  });

  it('is never read for Sales, who reads nothing a release holds', async () => {
    const { sb, calls } = flagClient({ data: true });
    const state = await loadShellState(sb, auth('sales'), visibleNav('sales'), kv(null));
    expect(state.releases).toBe(false);
    expect(calls.map((c) => c.fn)).not.toContain('releases_enabled');
  });

  it('draws nothing unless the database says true: off, a failure, anything else', async () => {
    for (const answer of [
      { data: false },
      { data: null },
      { data: 'true' },
      { error: { message: 'x' } },
    ]) {
      const { sb } = flagClient(answer);
      const state = await loadShellState(sb, auth('admin'), visibleNav('admin'), kv(null));
      expect(state.releases, JSON.stringify(answer)).toBe(false);
    }
  });

  it('the roles it reads for are exactly those that read a release-managed type', async () => {
    const { PENDING_ANY_CAP } = await import('@/lib/release/draftEndpoints');
    const { ROLE_CAPS } = await import('@/lib/authz/matrix');
    const { ROLES, CMS_ROLES } = await import('@/lib/auth/types');
    for (const role of ROLES) {
      const reads = PENDING_ANY_CAP.some((cap) =>
        ['full', 'view', 'meta'].includes(ROLE_CAPS[role][cap]),
      );
      expect((CMS_ROLES as readonly string[]).includes(role), role).toBe(reads);
    }
  }, 60_000);

  it('the layout draws the savebar only on that flag, after <main>', async () => {
    const { readFileSync } = await import('node:fs');
    const layout = readFileSync('src/layouts/AdminLayout.astro', 'utf8');
    expect(layout).toMatch(
      /<\/main>[\s\S]*app && session && shell\.releases && <AdminSavebar client:idle role=\{session\.role\} \/>/,
    );
    // The import (its name and its path) and the one place it is drawn.
    expect(layout.match(/AdminSavebar/g)).toHaveLength(3);
  });
});

describe('the counters registry (src/lib/admin/counters)', () => {
  it('holds exactly the counts the menu shows, each shown by a link', () => {
    // Pinned, not derived: a counter dropped from the registry must fail here.
    expect(Object.keys(COUNTERS).sort()).toEqual(['applications', 'leads']);
    const shown = ADMIN_NAV.flatMap((group) =>
      group.links.flatMap((link) => (link.count ? [link.count] : [])),
    );
    expect([...shown].sort()).toEqual(Object.keys(COUNTERS).sort());
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
