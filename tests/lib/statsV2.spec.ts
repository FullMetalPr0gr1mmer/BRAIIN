import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '@/lib/auth/types';
import { CTA_IDS } from '@schemas/analytics';
import { GOAL_METRICS, GoalCreateSchema, GoalUpdateSchema } from '@schemas/analyticsGoals';
import { ValidationError } from '@/lib/admin/errors';
import { loadEventSummary } from '@/lib/admin/stats/events';
import { goalProgressOf, goalResource, loadGoalProgress } from '@/lib/admin/stats/goals';
import { busiestHours, hourLabel, hoursOf, loadBusyHours } from '@/lib/admin/stats/hours';
import {
  CTA_LABELS,
  METRIC_LABELS,
  ctaLabel,
  goalCounts,
  goalPercent,
  interestKey,
} from '@/lib/admin/stats/labels';
import { daysOf, rangeOfDays } from '@/lib/admin/stats/range';
import { loadRealtime } from '@/lib/admin/stats/realtime';
import { realtimeOf, updatedLine } from '@/lib/admin/stats/realtimeView';
import {
  funnelSteps,
  inquiryWithoutService,
  loadVisitSummary,
  onePageShare,
  pagesPerVisit,
  visitTotalsOf,
} from '@/lib/admin/stats/visits';
import Realtime, { stateLine } from '@/components/admin/screens/realtime/Realtime';

const { logs } = vi.hoisted(() => ({ logs: [] as unknown[] }));
vi.mock('@/lib/data/systemLog', () => ({
  writeSystemLog: async (entry: unknown) => {
    logs.push(entry);
    return true;
  },
}));

// Website stats v2 (Admin v2 G1): the loaders over migration 0071's readers (each read with
// the session's tenant, the answer read leniently, a bound refusal a 422 and nothing logged,
// any other refusal logged and thrown), the words the tabs use, the goals' schemas, and the
// Realtime island's server render.

const auth = { tenantId: 't1', role: 'admin' } as AuthContext;
const NOW = Date.parse('2026-10-15T12:00:00Z');
const range = rangeOfDays(7, NOW);

interface Call {
  fn: string;
  args: Record<string, unknown>;
}

/** A client whose rpc answers from `answers` (a function per RPC) and records each call. */
function client(
  answers: Record<string, (args: Record<string, unknown>) => unknown>,
  tables: Record<string, unknown[]> = {},
) {
  const calls: Call[] = [];
  const reads: { table: string; filters: unknown[][] }[] = [];
  const sb = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      const answer = answers[fn];
      if (!answer) return { data: null, error: { code: '42883', message: 'no such function' } };
      const out = answer(args);
      return out instanceof Error
        ? {
            data: null,
            error: { code: (out as Error & { code?: string }).code, message: out.message },
          }
        : { data: out, error: null };
    },
    from: (table: string) => {
      const filters: unknown[][] = [];
      reads.push({ table, filters });
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in']) {
        builder[m] = (...args: unknown[]) => {
          filters.push([m, ...args]);
          return builder;
        };
      }
      builder['then'] = (resolve: (v: unknown) => unknown) =>
        resolve({ data: tables[table] ?? [], error: null });
      return builder;
    },
  } as unknown as SupabaseClient;
  return { sb, calls, reads };
}

const refusal = (code: string) => Object.assign(new Error('refused'), { code });

describe('visits', () => {
  const answer = {
    visits: 40,
    one_page_visits: 10,
    visit_views: 100,
    service_visits: 20,
    service_inquiry_visits: 6,
    inquiry_visits: 9,
    by_day: [{ day: range.from, visits: 7 }],
    first_day: '2026-09-01',
  };

  it('reads the range and the previous period when the visits rollup reaches back', async () => {
    const { sb, calls } = client({ visit_summary: () => answer });
    const summary = await loadVisitSummary(sb, auth, range);
    expect(calls.map((c) => c.args)).toEqual([
      { p_tenant: 't1', p_from: range.from, p_to: range.to },
      { p_tenant: 't1', p_from: range.prevFrom, p_to: range.prevTo },
    ]);
    expect(summary.current.visits).toBe(40);
    expect(summary.current.byDay).toHaveLength(7);
    expect(summary.current.byDay[0]).toEqual({ day: range.from, visits: 7 });
    expect(summary.current.byDay[1]).toEqual({ day: daysOf(range)[1], visits: 0 });
    expect(summary.previous?.visits).toBe(40);
  });

  it('reads no previous period when visits started counting inside it, or when asked not to', async () => {
    const late = client({ visit_summary: () => ({ ...answer, first_day: range.from }) });
    expect((await loadVisitSummary(late.sb, auth, range)).previous).toBeNull();
    expect(late.calls).toHaveLength(1);
    const skip = client({ visit_summary: () => answer });
    expect((await loadVisitSummary(skip.sb, auth, range, { previous: false })).previous).toBeNull();
    expect(skip.calls).toHaveLength(1);
  });

  it('reads an odd answer as zeros, never as NaN', () => {
    const totals = visitTotalsOf({ visits: '12', one_page_visits: -3, by_day: 'x' }, range);
    expect(totals.visits).toBe(12);
    expect(totals.onePageVisits).toBe(0);
    expect(totals.byDay.every((d) => d.visits === 0)).toBe(true);
  });

  it('pages per visit, one-page share, the funnel and the visits apart from it', () => {
    const t = visitTotalsOf(answer, range);
    expect(pagesPerVisit(t)).toBe(2.5);
    expect(onePageShare(t)).toBe(25);
    expect(funnelSteps(t).map((s) => s.visits)).toEqual([40, 20, 6]);
    expect(inquiryWithoutService(t)).toBe(3);
    const none = visitTotalsOf({}, range);
    expect(pagesPerVisit(none)).toBeNull();
    expect(onePageShare(none)).toBeNull();
  });
});

describe('events', () => {
  it('labels clicks by the vocabulary and interest by the published names, a slug as itself', async () => {
    const { sb, reads } = client(
      {
        event_summary: () => ({
          cta: [
            { key: 'whatsapp', events: 4, visits: 3 },
            { key: 'retired_id', events: 1, visits: 1 },
          ],
          interest: [
            { key: 'd:branding', events: 2, visits: 2 },
            { key: 's:logo', events: 1, visits: 1 },
            { key: 's:gone', events: 1, visits: 1 },
          ],
          cta_total: 5,
          interest_total: 4,
        }),
      },
      {
        disciplines: [{ slug: 'branding', name: { en: 'Branding', ar: 'x' } }],
        services: [{ slug: 'logo', title: { en: 'Logo Design', ar: 'x' } }],
      },
    );
    const summary = await loadEventSummary(sb, auth, range);
    expect(summary.cta.map((r) => r.label)).toEqual(['WhatsApp click', 'retired_id']);
    expect(summary.interest.map((r) => r.label)).toEqual(['Branding', 'Logo Design', 'gone']);
    expect(summary.ctaTotal).toBe(5);
    // The names are read for the slugs on the screen only, in the session's tenant.
    expect(reads.map((r) => r.table).sort()).toEqual(['disciplines', 'services']);
    for (const read of reads) expect(read.filters).toContainEqual(['eq', 'tenant_id', 't1']);
    const services = reads.find((r) => r.table === 'services')!;
    expect(services.filters).toContainEqual(['in', 'slug', ['logo', 'gone']]);
  });

  it('reads no names when there is no interest', async () => {
    const { sb, reads } = client({
      event_summary: () => ({ cta: [], interest: [], cta_total: 0, interest_total: 0 }),
    });
    await loadEventSummary(sb, auth, range);
    expect(reads).toEqual([]);
  });
});

describe('busiest hours', () => {
  it('asks in Riyadh time and reads 24 hours, a missing one as 0', async () => {
    const { sb, calls } = client({
      busy_hours: () => [
        { hour: 0, views: 3 },
        { hour: 21, views: 9 },
        { hour: 24, views: 99 },
      ],
    });
    const hours = await loadBusyHours(sb, auth, range);
    expect(calls[0]?.args).toEqual({
      p_tenant: 't1',
      p_from: range.from,
      p_to: range.to,
      p_tz: 'Asia/Riyadh',
    });
    expect(hours).toHaveLength(24);
    expect(hours[0]).toBe(3);
    expect(hours[21]).toBe(9);
    expect(hoursOf(null)).toEqual(Array.from({ length: 24 }, () => 0));
  });

  it('names the busiest four by views, ties by the earlier hour, only hours with views', () => {
    const views = Array.from({ length: 24 }, () => 0);
    views[9] = 5;
    views[14] = 8;
    views[3] = 5;
    views[22] = 1;
    views[23] = 1;
    expect(busiestHours(views)).toEqual([14, 3, 9, 22]);
    expect(busiestHours(Array.from({ length: 24 }, () => 0))).toEqual([]);
    expect(hourLabel(7)).toBe('07:00');
  });
});

describe('realtime', () => {
  const answer = {
    as_of: '2026-10-15T11:59:00Z',
    active_visits: 7,
    top_paths: [{ path: '/services', visits: 3 }],
    per_minute: Array.from({ length: 31 }, (_, i) => ({
      minute: new Date(Date.parse('2026-10-15T11:29:00Z') + i * 60_000).toISOString(),
      views: i,
    })),
  };

  it('reads one RPC in the session tenant, and keeps the last 30 minutes', async () => {
    const { sb, calls } = client({ realtime_summary: () => answer });
    const view = await loadRealtime(sb, auth);
    expect(calls).toEqual([{ fn: 'realtime_summary', args: { p_tenant: 't1' } }]);
    expect(view.activeVisits).toBe(7);
    expect(view.perMinute).toHaveLength(30);
    expect(view.perMinute[29]?.views).toBe(30);
    expect(updatedLine(view)).toBe('Updated 14:59, Riyadh time');
  });

  it('reads the JSON route’s own answer the same way (the island re-reads it)', () => {
    const view = realtimeOf(answer);
    expect(realtimeOf(JSON.parse(JSON.stringify(view)))).toEqual(view);
    expect(realtimeOf(null)).toEqual({ asOf: null, activeVisits: 0, topPaths: [], perMinute: [] });
  });

  it('the island renders the figures on the server, with Pause, and no style attribute', () => {
    const html = renderToStaticMarkup(createElement(Realtime, { initial: realtimeOf(answer) }));
    expect(html).not.toMatch(/\sstyle=/);
    expect(html).toContain('<span class="rt__n">7</span>');
    expect(html).toContain('people on the site right now');
    expect(html).toContain('active in the last 5 minutes');
    expect(html).toContain('Pause updates');
    expect(html).toContain('Updated 14:59, Riyadh time. Updates every minute.');
    expect(html).toContain('/services');
    expect(html).not.toContain('aria-live');
    expect(stateLine('auto')).toBe('Updates paused after 30 minutes.');
    expect(stateLine('paused')).toBe('Updates paused.');
  });
});

describe('goals', () => {
  it('reads progress; inquiries left null for a role the reader does not show them to', async () => {
    const { sb } = client({
      goal_progress: () => ({
        month_start: '2026-10-01',
        goals: [
          {
            id: 'g1',
            name: 'Clicks',
            metric: 'cta',
            cta: 'whatsapp',
            target: 10,
            version: 2,
            done: 4,
          },
          {
            id: 'g2',
            name: 'Leads',
            metric: 'inquiries',
            cta: null,
            target: 5,
            version: 1,
            done: null,
          },
          { id: 'g3', name: 'Odd', metric: 'unknown', cta: null, target: 5, version: 1, done: 1 },
        ],
      }),
    });
    const progress = await loadGoalProgress(sb, auth);
    expect(progress.monthStart).toBe('2026-10-01');
    expect(progress.goals.map((g) => [g.id, g.done])).toEqual([
      ['g1', 4],
      ['g2', null],
    ]);
    expect(goalPercent({ done: 4, target: 10 })).toBe(40);
    expect(goalPercent({ done: 40, target: 10 })).toBe(100);
    expect(goalPercent({ done: null, target: 10 })).toBeNull();
    expect(goalProgressOf(undefined)).toEqual({ monthStart: null, goals: [] });
  });

  it('the schemas pair a click with a click goal only, and bound the name and target', () => {
    const ok = { name: 'WhatsApp clicks', metric: 'cta', cta: 'whatsapp', target: 50 };
    expect(GoalCreateSchema.safeParse(ok).success).toBe(true);
    expect(GoalCreateSchema.safeParse({ ...ok, cta: null }).success).toBe(false);
    expect(GoalCreateSchema.safeParse({ ...ok, metric: 'visits' }).success).toBe(false);
    expect(GoalCreateSchema.safeParse({ ...ok, metric: 'visits', cta: null }).success).toBe(true);
    expect(GoalCreateSchema.safeParse({ ...ok, cta: 'made_up' }).success).toBe(false);
    expect(GoalCreateSchema.safeParse({ ...ok, name: '<b>x</b>' }).success).toBe(false);
    expect(GoalCreateSchema.safeParse({ ...ok, name: 'a'.repeat(81) }).success).toBe(false);
    expect(GoalCreateSchema.safeParse({ ...ok, target: 0 }).success).toBe(false);
    expect(GoalCreateSchema.safeParse({ ...ok, target: 1.5 }).success).toBe(false);
    expect(GoalCreateSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(GoalUpdateSchema.safeParse({ ...ok, version: 3 }).success).toBe(true);
    expect(GoalUpdateSchema.safeParse(ok).success).toBe(false);
  });

  it('writes the four fields only, and no click unless the goal counts one', () => {
    expect(
      goalResource.toRow({ name: 'n', metric: 'visits', cta: 'whatsapp', target: 3, version: 2 }),
    ).toEqual({ name: 'n', metric: 'visits', cta: null, target: 3 });
    expect(goalResource.toRow({ name: 'n', metric: 'cta', cta: 'email', target: 3 })).toEqual({
      name: 'n',
      metric: 'cta',
      cta: 'email',
      target: 3,
    });
    // analytics.goals writes and deletes; every analytics.read role reads.
    expect(goalResource.writeCap).toBe('analytics.goals');
    expect(goalResource.deleteCap).toBe('analytics.goals');
    expect(goalResource.readCaps).toEqual(['analytics.read']);
  });

  it('every click and every metric has its words', () => {
    expect(Object.keys(CTA_LABELS).sort()).toEqual([...CTA_IDS].sort());
    expect(Object.keys(METRIC_LABELS).sort()).toEqual([...GOAL_METRICS].sort());
    expect(ctaLabel('email')).toBe('Email click');
    expect(goalCounts('cta', 'whatsapp')).toBe('Clicks: WhatsApp click');
    expect(goalCounts('visits', null)).toBe('Visits');
    expect(interestKey('d:branding')).toEqual({ kind: 'discipline', slug: 'branding' });
    expect(interestKey('s:logo')).toEqual({ kind: 'service', slug: 'logo' });
    expect(interestKey('whatsapp')).toBeNull();
  });
});

describe('a refused read', () => {
  const loaders = [
    ['visit_summary', (sb: SupabaseClient) => loadVisitSummary(sb, auth, range)],
    ['event_summary', (sb: SupabaseClient) => loadEventSummary(sb, auth, range)],
    ['busy_hours', (sb: SupabaseClient) => loadBusyHours(sb, auth, range)],
    ['realtime_summary', (sb: SupabaseClient) => loadRealtime(sb, auth)],
    ['goal_progress', (sb: SupabaseClient) => loadGoalProgress(sb, auth)],
  ] as const;

  it.each(loaders)('%s: a bound refusal is a 422 and logs nothing', async (fn, load) => {
    logs.length = 0;
    const { sb } = client({ [fn]: () => refusal('22023') });
    await expect(load(sb)).rejects.toBeInstanceOf(ValidationError);
    expect(logs).toEqual([]);
  });

  it.each(loaders)('%s: any other refusal is logged and thrown', async (fn, load) => {
    logs.length = 0;
    const { sb } = client({ [fn]: () => refusal('42501') });
    await expect(load(sb)).rejects.not.toBeInstanceOf(ValidationError);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ level: 'error', source: 'admin:stats' });
  });
});
