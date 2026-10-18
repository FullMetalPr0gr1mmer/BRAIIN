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
import { ADMIN_TIME_ZONE } from '@/lib/admin/relTime';
import type { AuthContext } from '@/lib/auth/types';

vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));

// The attention list's kinds (public.dashboard_attention; Admin v2 U1 reads it, R5 / 0066 adds
// the release kinds). Every kind the LATEST definition of the view can emit has words on the
// dashboard (KIND_LABEL), but the UTC "scheduled today" the dashboard reads around (U1 D9);
// the view's Riyadh day is the admin's time zone; site health's content_health (0052) reads
// three kinds by name, none of the release ones; and the stale pending changes, which can be
// many once releases are on, are read on their own with an exact count, so they never crowd
// the content kinds out of the list's capped read.

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
