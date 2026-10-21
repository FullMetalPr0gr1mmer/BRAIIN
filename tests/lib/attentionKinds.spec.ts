import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  DRAFT_STALE_DAYS,
  RELEASE_ATTENTION_KINDS,
  RELEASE_ATTENTION_WINDOW_DAYS,
  RELEASE_OVERDUE_MINUTES,
} from '@schemas/release';
import {
  ATTENTION_READ_CAP,
  KIND_LABEL,
  STALE_DRAFT_KIND,
  createDashboardReads,
  widgetLoaders,
} from '@/lib/admin/dashboard/loaders';
import { WIDGETS } from '@/lib/admin/dashboard/widgets';
import { ADMIN_TIME_ZONE } from '@/lib/admin/relTime';
import { CMS_ROLES, ROLES, type AuthContext, type Role } from '@/lib/auth/types';
import { can } from '@/lib/authz/matrix';

vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));

// The attention list's kinds (public.dashboard_attention; Admin v2 U1 reads it, R5 / 0066 adds
// the release kinds). Every kind the LATEST definition of the view can emit has words on the
// dashboard (KIND_LABEL), but the UTC "scheduled today" the dashboard reads around (U1 D9);
// the view's Riyadh day is the admin's time zone; site health's content_health (0052) reads
// three kinds by name, none of the release ones; and the stale pending changes, which can be
// many once releases are on, are read on their own with an exact count, so they never crowd
// the content kinds out of the list's capped read. Since H13 (0100_attention_staff.sql) the
// list answers CMS staff only: the newest definition wraps the whole union in the staff test,
// H13's own text is 0066's v4 verbatim inside that wrapper, and every role whose screens read
// the list is CMS staff (Sales has none).

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations');
const strip = (sql: string) => sql.replace(/--[^\n]*/g, '');

/** The text of the newest `create or replace view public.dashboard_attention`, and its file. */
function latestView(): { file: string; text: string } {
  let found: { file: string; text: string } | null = null;
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort()) {
    const sql = strip(readFileSync(join(MIGRATIONS, file), 'utf8'));
    const at = sql.lastIndexOf('create or replace view public.dashboard_attention');
    if (at < 0) continue;
    const end = sql.indexOf(';', at);
    found = { file, text: sql.slice(at, end) };
  }
  if (!found) throw new Error('no migration defines public.dashboard_attention');
  return found;
}

/** Every literal kind the view emits: `select '<kind>'` and both arms of each CASE. */
function emittedKinds(view: string): string[] {
  const kinds = new Set<string>();
  for (const m of view.matchAll(/select\s+'([a-z_]+)'/g)) kinds.add(m[1]!);
  for (const m of view.matchAll(/then\s+'([a-z_]+)'/g)) kinds.add(m[1]!);
  for (const m of view.matchAll(/else\s+'([a-z_]+)'\s+end/g)) kinds.add(m[1]!);
  return [...kinds].sort();
}

describe('the attention kinds (latest public.dashboard_attention)', () => {
  const { file, text } = latestView();
  const kinds = emittedKinds(text);

  it('is read from the newest migration that defines it (0066 or later)', () => {
    expect(file >= '0066').toBe(true);
    expect(kinds).toContain('placeholder_live');
    expect(kinds).toContain('draft_stale');
  });

  it('every kind it can emit has a dashboard label, but the UTC "scheduled today" read around it', () => {
    const missing = kinds.filter((kind) => kind !== 'scheduled_today' && !KIND_LABEL[kind]);
    expect(missing).toEqual([]);
    expect(Object.keys(KIND_LABEL).sort()).toEqual(kinds.filter((k) => k !== 'scheduled_today'));
  });

  it('its release kinds are RELEASE_ATTENTION_KINDS, in plain words with no dashes', () => {
    for (const kind of RELEASE_ATTENTION_KINDS) {
      expect(kinds).toContain(kind);
      expect(KIND_LABEL[kind]).toMatch(/^[A-Z][a-z0-9 ]+$/);
    }
  });

  it("the Riyadh day it uses is the admin's time zone", () => {
    const zones = [...text.matchAll(/at time zone '([^']+)'/g)].map((m) => m[1]);
    expect(zones.length).toBeGreaterThan(0);
    for (const zone of zones) expect(zone).toBe(ADMIN_TIME_ZONE);
  });

  it('its thresholds are the shared constants (5 minutes, 7 days, 30 days)', () => {
    expect(text).toContain(`interval '${RELEASE_OVERDUE_MINUTES} minutes'`);
    expect(text).toContain(`interval '${RELEASE_ATTENTION_WINDOW_DAYS} days'`);
    expect(text).toContain(`interval '${DRAFT_STALE_DAYS} days'`);
    expect(STALE_DRAFT_KIND).toBe('draft_stale');
  });

  it("site health's content_health reads three content kinds by name, none of the release ones", () => {
    const sql = strip(readFileSync(join(MIGRATIONS, '0052_stats_health_rollups.sql'), 'utf8'));
    const filter = /from public\.dashboard_attention a\s+where a\.kind in \(([^)]*)\)/.exec(sql);
    const named = [...(filter?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(named.sort()).toEqual(['consent_missing', 'missing_alt', 'placeholder_live']);
    for (const kind of RELEASE_ATTENTION_KINDS) expect(named).not.toContain(kind);
  });

  it('answers CMS staff only: the staff test once, as the WHERE over the whole union (H13)', () => {
    // A restatement copied from a definition older than H13's would drop the wrapper; this
    // fails then. The second arm is the owner's psql session: no switched role, no role claim.
    expect(text).toMatch(
      /\)\s*a\s+where\s+app\.is_staff\(\)\s+or\s+\(pg_catalog\.current_setting\('role'\)\s*=\s*'none'\s+and\s+/,
    );
    expect(text.match(/is_staff\(/g)).toHaveLength(1);
    expect(text).toMatch(/#>>\s*'\{app_metadata,role\}'\)\s+is\s+null\)\s*$/);
  });
});

describe('H13: the attention list for CMS staff (0100_attention_staff.sql)', () => {
  const read = (name: string) =>
    readFileSync(join(MIGRATIONS, name), 'utf8').replace(/\r\n/g, '\n');
  const file = readdirSync(MIGRATIONS).find((f) => /^\d{4}_attention_staff\.sql$/.test(f));
  const CREATE =
    'create or replace view public.dashboard_attention with (security_invoker = true) as\n';
  const OPEN = "-- ---- 0066's dashboard_attention v4, verbatim ----\n";
  const CLOSE = "\n-- ---- end of 0066's text ----\n";

  it("restates 0066's v4 byte for byte between its markers, inside one outer select", () => {
    expect(file).toBeDefined();
    const v4src = read('0066_release_guard.sql');
    const from = v4src.indexOf(CREATE) + CREATE.length;
    const v4 = v4src.slice(from, v4src.indexOf(';', from));
    const src = read(file!);
    const at = src.indexOf(CREATE);
    expect(at).toBeGreaterThan(0);
    expect(src.slice(at + CREATE.length, src.indexOf(OPEN))).toBe(
      'select a.kind, a.entity_type, a.id, a.slug, a.title, a.at\n  from (\n',
    );
    expect(src.slice(src.indexOf(OPEN) + OPEN.length, src.indexOf(CLOSE))).toBe(v4);
    expect(src.slice(src.indexOf(CLOSE) + CLOSE.length)).toMatch(
      /^\s*\) a\n where app\.is_staff\(\)\n/,
    );
  });

  it('states the grants exactly as 0066 did: SELECT for authenticated, nothing for anyone else', () => {
    const v4src = read('0066_release_guard.sql');
    const src = read(file!);
    for (const line of [
      'revoke all on public.dashboard_attention from public, anon, authenticated, service_role;',
      'grant select on public.dashboard_attention to authenticated;',
    ]) {
      expect(v4src.split(line).length - 1, line).toBe(1);
      expect(src.split(line).length - 1, line).toBe(1);
    }
    expect(src).not.toMatch(
      /grant [^;]* on public\.dashboard_attention to (anon|public|service_role)/i,
    );
  });

  it('every role whose screens read the list is CMS staff (the dashboard widget, site health)', () => {
    const caps = [...WIDGETS.attention.anyCaps, 'siteHealth.view' as const];
    const readers = ROLES.filter((role: Role) => caps.some((cap) => can(role, cap) === 'full'));
    expect(readers.length).toBeGreaterThan(0);
    for (const role of readers) expect(CMS_ROLES as readonly string[], role).toContain(role);
    expect(readers).not.toContain('sales');
  });
});

// ---- The widget's reads -------------------------------------------------------------------

interface ViewCall {
  filters: [string, string, unknown][];
  limit: number | null;
  count: boolean;
}

const auth: AuthContext = {
  userId: 'u-1',
  tenantId: 't-1',
  role: 'admin',
  isActive: true,
  email: 'amal.k@example.test',
};

const NOW = new Date('2026-10-18T09:00:00.000Z');

/** Answers the attention view by its kind filters; every other table answers nothing. */
function fakeDb(view: { content: unknown[]; stale: unknown[]; staleCount: number }) {
  const calls: ViewCall[] = [];
  const sb = {
    from(table: string) {
      const call: ViewCall = { filters: [], limit: null, count: false };
      if (table === 'dashboard_attention') calls.push(call);
      const b: Record<string, unknown> = {};
      for (const op of ['eq', 'neq', 'gte', 'lt', 'in', 'is']) {
        b[op] = (column: string, value: unknown) => {
          call.filters.push([op, column, value]);
          return b;
        };
      }
      b['select'] = (_cols: string, opts?: { count?: string }) => {
        call.count = opts?.count === 'exact';
        return b;
      };
      b['order'] = () => b;
      b['limit'] = (n: number) => {
        call.limit = n;
        return b;
      };
      b['then'] = (resolve: (v: unknown) => unknown) => {
        if (table !== 'dashboard_attention') {
          return Promise.resolve({ data: [], count: 0, error: null }).then(resolve);
        }
        const stale = call.filters.some(([op, , v]) => op === 'eq' && v === STALE_DRAFT_KIND);
        return Promise.resolve(
          stale
            ? { data: view.stale, count: view.staleCount, error: null }
            : { data: view.content, count: view.content.length, error: null },
        ).then(resolve);
      };
      return b;
    },
    async rpc() {
      return { data: null, error: null };
    },
  };
  return { sb: sb as unknown as SupabaseClient, calls };
}

const row = (
  kind: string,
  entityType: string,
  id: string,
  slug: string,
  title: unknown = null,
) => ({
  kind,
  entity_type: entityType,
  id,
  slug,
  title,
  at: NOW.toISOString(),
});

async function attentionOf(view: Parameters<typeof fakeDb>[0]) {
  const { sb, calls } = fakeDb(view);
  const ctx = { sb, auth, now: NOW, siteUrl: 'https://site.example' };
  const loaders = widgetLoaders(ctx, createDashboardReads(ctx), { items: [] });
  return { data: await loaders.attention(), calls };
}

describe('the attention widget and the release kinds', () => {
  it('reads the content kinds capped, and stale pending changes on their own with an exact count', async () => {
    const { calls } = await attentionOf({ content: [], stale: [], staleCount: 0 });
    expect(calls).toHaveLength(2);
    const content = calls.find((c) => c.filters.some(([op]) => op === 'neq'))!;
    expect(content.filters).toContainEqual(['neq', 'kind', 'scheduled_today']);
    expect(content.filters).toContainEqual(['neq', 'kind', STALE_DRAFT_KIND]);
    expect(content.limit).toBe(ATTENTION_READ_CAP);
    const stale = calls.find((c) => c.filters.some(([op]) => op === 'eq'))!;
    expect(stale.filters).toEqual([['eq', 'kind', STALE_DRAFT_KIND]]);
    expect(stale.count).toBe(true);
  });

  it('a thousand stale pending changes leave every content row in the list, and are counted', async () => {
    const content = [row('placeholder_live', 'portfolio', 'p1', 'sample', { en: 'Sample' })];
    const stale = Array.from({ length: 5 }, (_, i) =>
      row('draft_stale', 'page_section', `d${i}`, '', { en: `Change ${i}` }),
    );
    const { data } = await attentionOf({ content, stale, staleCount: 1000 });
    const byKind = Object.fromEntries(data.groups.map((g) => [g.kind, g]));
    expect(byKind['placeholder_live']?.count).toBe(1);
    expect(byKind['draft_stale']?.count).toBe(1000);
    expect(byKind['draft_stale']?.label).toBe('Pending changes untouched for 30 days');
    // A section's pending change has no page slug of its own: no "On the  page" line.
    expect(byKind['draft_stale']?.rows.every((r) => r.where === null)).toBe(true);
    expect(byKind['draft_stale']?.rows[0]?.href).toBe('/admin/sections/d0');
  });

  it('a release row has its words: the kind, the type, a title from its note or number, no link', async () => {
    const content = [
      row('release_scheduled_today', 'release', 'r1', '', { en: 'Evening drop', ar: 'x' }),
      row('release_overdue', 'release', 'r2', ''),
      row('purge_failed', 'release', 'r3', 'v12'),
    ];
    const { data } = await attentionOf({ content, stale: [], staleCount: 0 });
    const byKind = Object.fromEntries(data.groups.map((g) => [g.kind, g]));
    expect(byKind['release_scheduled_today']?.label).toBe('Release going live today');
    expect(byKind['release_scheduled_today']?.rows[0]).toMatchObject({
      title: 'Evening drop',
      type: 'Release',
      href: null,
      where: null,
    });
    expect(byKind['release_overdue']?.rows[0]?.title).toBe('A scheduled release');
    expect(byKind['purge_failed']?.label).toBe('Website cache not refreshed after a release');
    expect(byKind['purge_failed']?.rows[0]?.title).toBe('Version 12');
    expect(data.groups.some((g) => g.kind === 'draft_stale')).toBe(false);
  });
});
