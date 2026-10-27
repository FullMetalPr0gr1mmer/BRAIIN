import type { SupabaseClient } from '@supabase/supabase-js';
import {
  hasColumns,
  isCustomItem,
  readDashboardLayout,
  type DashboardLayout,
  type QuickItem,
  type WidgetId,
} from '@schemas/dashboard';
import type { AuthContext } from '@/lib/auth/types';
import { can, type Capability } from '@/lib/authz/matrix';
import { writeSystemLog } from '@/lib/data/systemLog';
import { resolveLeadInterests, withInterestLabels } from '@/lib/leads/interestLabel';
import { scrubPii } from '@/lib/log/scrub';
import { personOf, readPeople } from '../activity';
import { describe, sentence, type ActivityRow } from '../auditLabels';
import { loadHealthSummary, type HealthSummary } from '../health/summary';
import type { IconName } from '../icons';
import { percentChange, pointChange, type DeltaUnit } from '../kpi';
import { goingLiveToday } from '../notifications/scheduled';
import { readMyDashboardPrefs, type MyDashboardPrefs } from '../prefs';
import { libraryAction } from '../quickActions';
import { DEFAULT_TIME_ZONE } from '@schemas/timeZones';
import { dayKeyIn } from '@/lib/time/zone';
import { dailyArabicShare, loadPageviewSummary, type PageviewSummary } from '../stats/pageviews';
import { dayLabel, hasPreviousPeriod, rangeOfDays } from '../stats/range';
import { count as countOf, record } from '../stats/read';
import { loadRealtime } from '../stats/realtime';
import type { RealtimeView } from '../stats/realtimeView';
import { resolveLayout, resolveQuick, shownWidgets, type LayoutSource } from './layout';
import { readMyRolePreset, type RolePreset } from './roleDefaults';
import { readTeamNotes, type TeamNotes } from './teamNotes';

// What the dashboard reads (Admin v2 U1): the person's layout, then only the widgets it shows,
// each through the caller's RLS-bound client, so the database applies ROLE_CAPS a second time.
// A widget the role cannot see is never in a layout (resolveLayout drops it), so its loader
// never runs: Content Creator and SEO never query leads or applications, not even for a count.
// Reads two widgets share (the page views, the lead summary, the attention list) are read once
// per render; "going live today" is the bell's read, kept per request by its module. A widget
// whose read fails shows its own error and is logged (system_logs): the page still renders
// (CLAUDE.md §8, per-section error isolation, applied to widgets).
//
// Subrequests, at most (README P-15: 50 on the Workers Free plan), for an Admin with every
// widget on the board: the preferences and the preset (2), the homepage's id (1), the page
// views over 30 and 7 days (2), the lead summary (1), the leads of 30 days (1), the latest
// leads with their stages and interests (4), the attention list and its stale pending
// changes (2, plus the bell's two; R5 split the second out), site health (4), the activity
// and its names (2), the applications (1), the disciplines and their labels (3), the note
// (1): 25, plus what the shell reads (tests/lib/dashboardWidgets.spec.ts
// counts both; docs/admin-v2/as-built/U1.md has the measured total).

const SOURCE = 'admin:dashboard';
const DAY_MS = 86_400_000;
/** The most lead rows a count reads (counted in the Worker; PostgREST answers 1,000 at most). */
export const LEAD_COUNT_CAP = 1000;

// ── The data each widget renders ─────────────────────────────────────────────────────

export interface KpiCard {
  label: string;
  value: number | string;
  delta: number | null;
  deltaUnit?: DeltaUnit;
  /** What the change is against ("the previous 7 days"). */
  period?: string;
  spark?: number[];
  series?: number;
}

export interface QuickLink {
  id: string;
  label: string;
  href: string;
  icon: IconName;
  /** Opens in a new tab: the public site, or a person's https link. */
  external: boolean;
  /** A person's own link (not a library action). */
  custom: boolean;
}

export interface ViewsData {
  labels: string[];
  en: number[];
  ar: number[];
  total: number;
  /** The leads' own chart (lead roles only): per Riyadh day, the last 30. */
  leads: { labels: string[]; counts: number[]; total: number; capped: boolean } | null;
}

export interface LeadsData {
  rows: {
    id: string;
    name: string;
    interest: string | null;
    stage: { label: string; tone: string } | null;
    at: string;
  }[];
}

export interface AttentionGroup {
  kind: string;
  label: string;
  count: number;
  rows: {
    title: string;
    type: string;
    href: string | null;
    where: string | null;
    at: string | null;
  }[];
}

export interface AttentionData {
  goingLive: { title: string; href: string; at: string }[];
  groups: AttentionGroup[];
}

export interface ActivityItem {
  who: string;
  what: string;
  at: string;
}

export interface BarDatum {
  label: string;
  value: number;
}

export interface WidgetDataMap {
  kpis: KpiCard[];
  quick: QuickLink[];
  views: ViewsData;
  leads: LeadsData;
  attention: AttentionData;
  health: HealthSummary;
  activity: ActivityItem[];
  applications: { count: number };
  pages: BarDatum[];
  disciplines: { items: BarDatum[]; total: number; capped: boolean };
  notes: TeamNotes;
  realtime: RealtimeView;
  /** R13: the card fetches its own figures in the browser (GET /api/admin/releases/status). */
  publish: null;
}

export type WidgetResult<K extends WidgetId = WidgetId> =
  { ok: true; data: WidgetDataMap[K] } | { ok: false };

export type WidgetResults = { [K in WidgetId]?: WidgetResult<K> };

export interface DashboardBanners {
  /** Published or visible placeholder content, for the roles that can read it. */
  placeholdersLive: number;
}

export interface Dashboard {
  layout: DashboardLayout;
  source: LayoutSource;
  widgets: WidgetResults;
  banners: DashboardBanners;
  /** The person's stored preferences (the island saves against their version), or null. */
  prefs: MyDashboardPrefs | null;
  /** The quick actions as stored (the editor starts from them). */
  quick: QuickItem[];
  /** The homepage's editor for pages.write holders, or null. */
  homeHref: string | null;
}

export interface DashboardContext {
  sb: SupabaseClient;
  auth: AuthContext;
  now: Date;
  /** PUBLIC_SITE_URL: the sub-line names its host. */
  siteUrl: string;
  /** The studio's time zone (Admin v2 U9): whose days the leads chart counts. */
  tz?: string;
}

// ── The attention list's words (0028's kinds, and 0066's release kinds) ────────────────

/** Every kind the attention view emits but the UTC "scheduled today" (read around, U1 D9). */
export const KIND_LABEL: Readonly<Record<string, string>> = {
  stale: 'Not updated in 180 days',
  missing_image: 'Published without a cover image',
  placeholder_live: 'Placeholder content is live',
  placeholder_pending: 'Placeholders awaiting real content',
  missing_alt: 'Published project images without alt text',
  consent_missing: 'Quotes on a page without recorded consent',
  // Releases (0066, R5): no row exists until R3, R7 or R11 writes one.
  release_scheduled_today: 'Release going live today',
  release_overdue: 'Release late to go live',
  release_failed: 'Release that could not go live',
  purge_failed: 'Website cache not refreshed after a release',
  draft_stale: 'Pending changes untouched for 30 days',
};

/**
 * Pending changes can be many once releases are on, and the list's read is capped (below), so
 * they are read on their own, with an exact count: they never crowd the content kinds out.
 */
export const STALE_DRAFT_KIND = 'draft_stale';
/** The most attention rows one read takes (PostgREST answers 1,000 at most). */
export const ATTENTION_READ_CAP = 500;

/** The view's entity_type to the editor that opens it; one this map does not know is text. */
const RESOURCE_OF: Readonly<Record<string, string>> = {
  service: 'services',
  blog_post: 'blog',
  portfolio: 'portfolio',
  testimonial: 'testimonials',
  team_member: 'team',
  statistic: 'statistics',
  client: 'clients',
  page_section: 'sections',
  service_case: 'service-cases',
};

const TYPE_LABEL: Readonly<Record<string, string>> = {
  service: 'Service',
  blog_post: 'Post',
  portfolio: 'Project',
  testimonial: 'Testimonial',
  team_member: 'Team member',
  statistic: 'Statistic',
  client: 'Client',
  page_section: 'Page section',
  service_case: 'Service case',
  release: 'Release',
};

interface AttentionRow {
  kind: string;
  entity_type: string;
  id: string;
  slug: string;
  title: Record<string, string> | null;
  at: string | null;
}

const ATTENTION_CAPS: readonly Capability[] = ['blog.write', 'services.write', 'seo.entityMeta'];
/** Rows shown per kind; the count says how many there are. */
const ATTENTION_ROWS = 5;

// ── Helpers ────────────────────────────────────────────────────────────────────────────

/** The studio's calendar day (YYYY-MM-DD) that holds an instant (Admin v2 U9: its zone). */
export function studioDate(at: number, tz: string = DEFAULT_TIME_ZONE): string {
  return dayKeyIn(at, tz);
}

/** Counts instants per studio day over the `days` days ending today, oldest first. */
export function perStudioDay(
  instants: readonly string[],
  days: number,
  now: Date,
  tz: string = DEFAULT_TIME_ZONE,
): { days: string[]; counts: number[] } {
  const riyadhDate = (at: number) => studioDate(at, tz);
  const keys: string[] = [];
  for (let i = days - 1; i >= 0; i -= 1) keys.push(riyadhDate(now.getTime() - i * DAY_MS));
  const unique = [...new Set(keys)];
  const at = new Map(unique.map((day, index) => [day, index]));
  const counts = unique.map(() => 0);
  for (const instant of instants) {
    const index = at.get(riyadhDate(Date.parse(instant)));
    if (index !== undefined) counts[index] = (counts[index] ?? 0) + 1;
  }
  return { days: unique, counts };
}

const titleOf = (value: unknown, fallback: string): string => {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value === 'object') {
    const en = (value as { en?: unknown }).en;
    if (typeof en === 'string' && en.trim()) return en.trim();
  }
  return fallback;
};

/** What a row is called when it has no title of its own: its slug, else a plain name. */
function fallbackTitle(row: AttentionRow): string {
  if (row.entity_type === 'release') {
    return row.slug ? `Version ${row.slug.replace(/^v/, '')}` : 'A scheduled release';
  }
  if (row.slug) return row.slug;
  return row.kind === STALE_DRAFT_KIND ? 'A pending change' : 'Untitled';
}

function memo<T>(work: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | null = null;
  return () => (cached ??= work());
}

const sum = (values: readonly number[]) => values.reduce((total, v) => total + v, 0);

// ── The loaders ────────────────────────────────────────────────────────────────────────

/** The reads for one render. Each runs at most once, and only when a visible widget asks. */
export function createDashboardReads(ctx: DashboardContext) {
  const { sb, auth, now } = ctx;
  const may = (cap: Capability) => can(auth.role, cap) === 'full';

  const pageviews30 = memo(() =>
    loadPageviewSummary(sb, auth, rangeOfDays(30, now.getTime()), null, { previous: false }),
  );
  const pageviews7 = memo(() =>
    loadPageviewSummary(sb, auth, rangeOfDays(7, now.getTime()), null, { previous: false }),
  );

  const newLeads = memo(async () => {
    const { data, error } = await sb.rpc('lead_summary', { p_tenant: auth.tenantId, p_filter: {} });
    if (error) throw new Error(`lead summary: ${error.code ?? error.message}`);
    return countOf(record(data)['new']);
  });

  /** The arrival times of the non-spam leads of the last 30 days, newest first. */
  const leads30 = memo(async () => {
    const since = new Date(now.getTime() - 30 * DAY_MS).toISOString();
    const { data, error } = await sb
      .from('leads')
      .select('created_at')
      .eq('tenant_id', auth.tenantId)
      .eq('is_spam', false)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(LEAD_COUNT_CAP);
    if (error) throw new Error(`leads of 30 days: ${error.code ?? error.message}`);
    return ((data ?? []) as { created_at: string }[]).map((row) => row.created_at);
  });

  const attentionRows = memo(async () => {
    // A security_invoker view (0028, 0066): RLS decides; a role with no content access sees
    // none. "Going live today" is not read from it: its day is UTC's (README U1 D9). Stale
    // pending changes are read on their own (staleDrafts), so they never fill the cap.
    const { data, error } = await sb
      .from('dashboard_attention')
      .select('kind,entity_type,id,slug,title,at')
      .neq('kind', 'scheduled_today')
      .neq('kind', STALE_DRAFT_KIND)
      .limit(ATTENTION_READ_CAP);
    if (error) throw new Error(`attention: ${error.code ?? error.message}`);
    return (data ?? []) as AttentionRow[];
  });

  /** The oldest stale pending changes the widget shows, and how many there are (0066). */
  const staleDrafts = memo(async () => {
    const { data, error, count } = await sb
      .from('dashboard_attention')
      .select('kind,entity_type,id,slug,title,at', { count: 'exact' })
      .eq('kind', STALE_DRAFT_KIND)
      .order('at', { ascending: true })
      .limit(ATTENTION_ROWS);
    if (error) throw new Error(`stale drafts: ${error.code ?? error.message}`);
    const rows = (data ?? []) as AttentionRow[];
    return { rows, count: count ?? rows.length };
  });

  const homeId = memo(async () => {
    const { data, error } = await sb
      .from('pages')
      .select('id')
      .eq('tenant_id', auth.tenantId)
      .eq('slug', 'home')
      .maybeSingle<{ id: string }>();
    if (error) throw new Error(`homepage: ${error.code ?? error.message}`);
    return data?.id ?? null;
  });

  const headCount = async (table: 'pages' | 'services') => {
    const { count, error } = await sb
      .from(table)
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', auth.tenantId)
      .eq('status', 'published');
    if (error) throw new Error(`${table} live: ${error.code ?? error.message}`);
    return count ?? 0;
  };

  return {
    may,
    pageviews30,
    pageviews7,
    newLeads,
    leads30,
    attentionRows,
    staleDrafts,
    homeId,
    headCount,
  };
}

export type DashboardReads = ReturnType<typeof createDashboardReads>;

const percent = (value: number) =>
  `${new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 }).format(value)}%`;

/** The 7-day figures from the 30-day series (one read): this week, the week before. */
function weekOf(summary: PageviewSummary, now: Date) {
  const days = summary.current.byDay;
  const last = days.slice(-7);
  const before = days.slice(-14, -7);
  const hasBefore = hasPreviousPeriod(summary.firstDay, rangeOfDays(7, now.getTime()));
  const views = sum(last.map((d) => d.en + d.ar));
  const ar = sum(last.map((d) => d.ar));
  const prevViews = hasBefore ? sum(before.map((d) => d.en + d.ar)) : null;
  const prevAr = hasBefore ? sum(before.map((d) => d.ar)) : null;
  return {
    last,
    views,
    share: views > 0 ? (ar / views) * 100 : null,
    prevViews,
    prevShare:
      prevViews !== null && prevViews > 0 && prevAr !== null ? (prevAr / prevViews) * 100 : null,
  };
}

type Loaders = { [K in WidgetId]: () => Promise<WidgetDataMap[K]> };

/**
 * One loader per widget. `quick` takes what the layout step read (the person's and the
 * preset's lists); the rest read for themselves through `reads`.
 */
export function widgetLoaders(
  ctx: DashboardContext,
  reads: DashboardReads,
  quick: { items: QuickItem[] },
): Loaders {
  const { sb, auth, now } = ctx;
  return {
    async kpis() {
      const week = weekOf(await reads.pageviews30(), now);
      const cards: KpiCard[] = [
        {
          label: 'Page views, 7 days',
          value: week.views,
          delta: percentChange(week.views, week.prevViews),
          period: 'the previous 7 days',
          spark: week.last.map((d) => d.en + d.ar),
        },
        {
          label: 'Arabic share',
          value: week.share === null ? 'No views yet' : percent(week.share),
          delta: pointChange(week.share, week.prevShare),
          deltaUnit: 'points',
          period: 'the previous 7 days',
          spark: dailyArabicShare(week.last),
          series: 1,
        },
      ];
      if (reads.may('leads.manage')) {
        // "Won this quarter" waits for the CRM's lead values (README U1 D7).
        cards.push({ label: 'New leads waiting', value: await reads.newLeads(), delta: null });
      } else {
        const [pagesLive, servicesLive] = await Promise.all([
          reads.headCount('pages'),
          reads.headCount('services'),
        ]);
        cards.push({ label: 'Pages live', value: pagesLive, delta: null });
        cards.push({ label: 'Services live', value: servicesLive, delta: null });
      }
      return cards;
    },

    async quick() {
      const needsHome = quick.items.some((item) => item.id === 'edit-home');
      const home = needsHome ? await reads.homeId().catch(() => null) : null;
      return quick.items.flatMap((item): QuickLink[] => {
        if (isCustomItem(item)) {
          return [
            {
              id: item.id,
              label: item.label,
              href: item.href,
              icon: item.icon,
              external: !item.href.startsWith('/'),
              custom: true,
            },
          ];
        }
        const action = libraryAction(item.id);
        if (!action) return [];
        const href =
          action.href === 'home'
            ? home
              ? `/admin/pages/${home}`
              : '/admin/pages'
            : action.href === 'site'
              ? '/'
              : action.href;
        return [
          {
            id: action.id,
            label: action.label,
            href,
            icon: action.icon,
            external: action.href === 'site',
            custom: false,
          },
        ];
      });
    },

    async views() {
      const summary = await reads.pageviews30();
      const days = summary.current.byDay;
      let leads: ViewsData['leads'] = null;
      if (reads.may('leads.manage')) {
        const instants = await reads.leads30();
        const counted = perStudioDay(instants, 30, now, ctx.tz);
        leads = {
          labels: counted.days.map((day) => dayLabel(day)),
          counts: counted.counts,
          total: instants.length,
          capped: instants.length >= LEAD_COUNT_CAP,
        };
      }
      return {
        labels: days.map((d) => dayLabel(d.day)),
        en: days.map((d) => d.en),
        ar: days.map((d) => d.ar),
        total: summary.current.total,
        leads,
      };
    },

    async leads() {
      const [list, stages] = await Promise.all([
        sb.rpc('leads_list', { p_tenant: auth.tenantId, p_filter: { limit: 6, sort: 'newest' } }),
        sb.from('lead_stages').select('id,label,tone').eq('tenant_id', auth.tenantId),
      ]);
      if (list.error) throw new Error(`latest leads: ${list.error.code ?? list.error.message}`);
      if (stages.error)
        throw new Error(`lead stages: ${stages.error.code ?? stages.error.message}`);
      const page = record(list.data);
      // The safe columns only (§3): no budget, no contact detail is read or shown.
      const rows = (Array.isArray(page['rows']) ? page['rows'] : []) as Record<string, unknown>[];
      const picked = rows.map((row) => ({
        id: String(row['id'] ?? ''),
        name: typeof row['name'] === 'string' ? row['name'] : '',
        service_of_interest:
          typeof row['service_of_interest'] === 'string' ? row['service_of_interest'] : null,
        discipline_of_interest:
          typeof row['discipline_of_interest'] === 'string' ? row['discipline_of_interest'] : null,
        stage_id: typeof row['stage_id'] === 'string' ? row['stage_id'] : null,
        created_at: typeof row['created_at'] === 'string' ? row['created_at'] : '',
      }));
      const labels =
        picked.length > 0 ? await resolveLeadInterests(sb, auth.tenantId, picked) : null;
      const stageOf = new Map(
        ((stages.data ?? []) as { id: string; label: string; tone: string }[]).map((s) => [
          s.id,
          s,
        ]),
      );
      return {
        rows: picked.map((row) => {
          const labelled = labels ? withInterestLabels(row, labels) : null;
          const stage = row.stage_id ? stageOf.get(row.stage_id) : undefined;
          return {
            id: row.id,
            name: row.name.trim() || 'Someone',
            interest: labelled?.service_label?.en ?? labelled?.discipline_label?.en ?? null,
            stage: stage ? { label: stage.label, tone: stage.tone } : null,
            at: row.created_at,
          };
        }),
      };
    },

    async attention() {
      const mayContent = ATTENTION_CAPS.some((cap) => reads.may(cap));
      const [rows, stale, live] = await Promise.all([
        mayContent ? reads.attentionRows() : Promise.resolve([] as AttentionRow[]),
        mayContent
          ? reads.staleDrafts()
          : Promise.resolve({ rows: [] as AttentionRow[], count: 0 }),
        reads.may('services.write') || reads.may('blog.write')
          ? goingLiveToday(sb, auth, now, ctx.tz)
          : Promise.resolve([]),
      ]);
      // A sample quote is listed as a placeholder and again as "no consent" (it has none by
      // design): its fix is "make it real", which the placeholder list already says.
      const samples = new Set(
        rows.filter((row) => row.kind.startsWith('placeholder_')).map((row) => row.id),
      );
      const byKind = new Map<string, AttentionRow[]>();
      for (const row of rows) {
        if (row.kind === 'consent_missing' && samples.has(row.id)) continue;
        byKind.set(row.kind, [...(byKind.get(row.kind) ?? []), row]);
      }
      const counts = new Map([...byKind.entries()].map(([kind, list]) => [kind, list.length]));
      if (stale.count > 0) {
        byKind.set(STALE_DRAFT_KIND, stale.rows);
        counts.set(STALE_DRAFT_KIND, stale.count);
      }
      return {
        goingLive: live.map((item) => ({
          title: item.title ?? 'An item',
          href: item.href,
          at: item.at,
        })),
        groups: [...byKind.entries()].map(([kind, list]) => ({
          kind,
          label: KIND_LABEL[kind] ?? kind.replaceAll('_', ' '),
          count: counts.get(kind) ?? list.length,
          rows: list.slice(0, ATTENTION_ROWS).map((row) => ({
            title: titleOf(row.title, fallbackTitle(row)),
            type: TYPE_LABEL[row.entity_type] ?? row.entity_type.replaceAll('_', ' '),
            href: RESOURCE_OF[row.entity_type]
              ? `/admin/${RESOURCE_OF[row.entity_type]}/${row.id}`
              : null,
            // A pending change's slug is its own (a section's draft has none): no page line.
            where:
              row.entity_type === 'page_section' && row.kind !== STALE_DRAFT_KIND
                ? `On the ${row.slug} page`
                : null,
            at: row.at,
          })),
        })),
      };
    },

    health: () => loadHealthSummary(sb, auth, now.getTime(), ctx.tz),

    async activity() {
      const { data, error } = await sb
        .from('audit_log')
        .select('id,actor_id,actor_role,action,entity_type,entity_id,detail,created_at')
        .eq('tenant_id', auth.tenantId)
        .order('id', { ascending: false })
        .limit(5);
      if (error) throw new Error(`activity: ${error.code ?? error.message}`);
      const rows = (data ?? []) as ActivityRow[];
      const ids = rows.map((row) => row.actor_id).filter((id): id is string => !!id);
      const people =
        ids.length > 0 ? await readPeople(sb, auth.tenantId, ids).catch(() => null) : null;
      // The activity log's own words (src/lib/admin/auditLabels.ts): changed fields' names,
      // never what they hold; no item titles here (the log has them).
      return rows.map((row) => ({
        who: personOf(row, people ?? new Map()).name,
        what: sentence(describe(row)),
        at: row.created_at,
      }));
    },

    async applications() {
      const { count, error } = await sb
        .from('job_applications')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', auth.tenantId)
        .eq('status', 'new');
      if (error) throw new Error(`applications: ${error.code ?? error.message}`);
      return { count: count ?? 0 };
    },

    async pages() {
      const summary = await reads.pageviews7();
      return summary.current.topPaths.slice(0, 6).map((p) => ({ label: p.path, value: p.views }));
    },

    async disciplines() {
      const since = new Date(now.getTime() - 90 * DAY_MS).toISOString();
      const { data, error } = await sb
        .from('leads')
        .select('discipline_of_interest')
        .eq('tenant_id', auth.tenantId)
        .eq('is_spam', false)
        .gte('created_at', since)
        .limit(LEAD_COUNT_CAP);
      if (error) throw new Error(`leads by discipline: ${error.code ?? error.message}`);
      const rows = (data ?? []) as { discipline_of_interest: string | null }[];
      const counts = new Map<string, number>();
      for (const row of rows) {
        const key = row.discipline_of_interest?.trim() || '';
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const slugs = [...counts.keys()].filter(Boolean);
      const labels =
        slugs.length > 0
          ? await resolveLeadInterests(
              sb,
              auth.tenantId,
              slugs.map((slug) => ({ service_of_interest: null, discipline_of_interest: slug })),
            )
          : null;
      const items = [...counts.entries()]
        .map(([slug, value]) => ({
          label: slug ? (labels?.get(`discipline:${slug}`)?.label.en ?? slug) : 'Not given',
          value,
        }))
        .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
      return { items, total: rows.length, capped: rows.length >= LEAD_COUNT_CAP };
    },

    notes: () => readTeamNotes(sb, auth),

    // "Right now" (G1b): one read of the minute rollup, as the stats' Realtime tab.
    realtime: () => loadRealtime(sb, auth),

    // "Publish status" (R13): nothing read here; the card asks the status route itself, so the
    // dashboard's render pays no release read for it (P-15).
    publish: async () => null,
  };
}

/** Runs one widget's loader; a failure is logged and the widget says it could not load. */
async function settleWidget<K extends WidgetId>(
  id: K,
  loader: () => Promise<WidgetDataMap[K]>,
  auth: AuthContext,
): Promise<WidgetResult<K>> {
  try {
    return { ok: true, data: await loader() };
  } catch (err) {
    await writeSystemLog({
      level: 'error',
      source: SOURCE,
      message: `Dashboard widget ${id} could not be read`,
      detail: {
        error: scrubPii(err instanceof Error ? err.message : String(err)),
        role: auth.role,
      },
    });
    return { ok: false };
  }
}

/**
 * The dashboard for the signed-in person: their layout (theirs, else their role's preset,
 * else the code's), and each widget it shows, loaded once. A failed preferences read shows
 * the role's layout and leaves editing off (prefs null).
 */
export async function loadDashboard(ctx: DashboardContext): Promise<Dashboard> {
  const { sb, auth } = ctx;
  const prefs = await readMyDashboardPrefs(sb, auth).catch(() => null);
  const stored = prefs?.dashboard ?? {};
  // The preset is read only when the person's own layout or quick list leaves a gap.
  const needPreset = !hasColumns(stored) || readDashboardLayout(stored).quickSet !== true;
  const preset: RolePreset | null = needPreset
    ? await readMyRolePreset(sb, auth).catch(() => null)
    : null;
  const { layout, source } = resolveLayout(stored, preset?.dashboard, auth.role);
  const quick = resolveQuick(
    stored,
    prefs?.quickActions,
    preset?.dashboard,
    preset?.quickActions,
    auth.role,
  );

  const reads = createDashboardReads(ctx);
  const loaders = widgetLoaders(ctx, reads, quick);
  const shown = shownWidgets(layout);
  const mayPages = reads.may('pages.write');
  const mayContent = ATTENTION_CAPS.some((cap) => reads.may(cap));

  const [results, attention, home] = await Promise.all([
    Promise.all(shown.map((id) => settleWidget(id, loaders[id] as () => Promise<never>, auth))),
    // The banner reads the attention list for the roles that may read it, shown or not.
    mayContent ? reads.attentionRows().catch(() => [] as AttentionRow[]) : Promise.resolve([]),
    mayPages ? reads.homeId().catch(() => null) : Promise.resolve(null),
  ]);

  const widgets: WidgetResults = {};
  shown.forEach((id, index) => {
    (widgets as Record<string, unknown>)[id] = results[index];
  });
  return {
    layout,
    source,
    widgets,
    banners: {
      placeholdersLive: attention.filter((row) => row.kind === 'placeholder_live').length,
    },
    prefs,
    quick: quick.items,
    homeHref: mayPages ? (home ? `/admin/pages/${home}` : '/admin/pages') : null,
  };
}
