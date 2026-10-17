import { WIDGET_IDS, type DashboardLayout, type WidgetId } from '@schemas/dashboard';
import type { Role } from '@/lib/auth/types';
import { CAPABILITIES, ROLE_CAPS, type Access, type Capability } from '@/lib/authz/matrix';

// The dashboard's widget registry (Admin v2 U1, docs/admin-v2/ui.md §4 "Dashboard", AV-09).
// One entry per widget: what it is called, what it shows, and the capabilities that show it
// (any one of them, in full; none listed = every member). ROLE_CAPS decides, and the loaders
// (./loaders.ts) never run for a widget the role cannot see, so Content Creator and SEO never
// query leads or applications, not even for a count. RLS applies the same rule again.
//
// Later slices register theirs here (publish, R13; pipeline and tasks, the CRM): an id in
// WIDGET_IDS (packages/schemas/dashboard.ts), an entry below, a loader and a partial.

export interface WidgetDef {
  id: WidgetId;
  label: string;
  description: string;
  /** Any one of these in full shows the widget; empty = every member. */
  anyCaps: readonly Capability[];
  /** Spans the board's width when it sits in the top column (the KPI row). */
  full?: boolean;
}

export const WIDGETS: Readonly<Record<WidgetId, WidgetDef>> = {
  kpis: {
    id: 'kpis',
    label: 'Key numbers',
    description: 'Page views, the Arabic share and, for lead roles, new leads waiting',
    anyCaps: ['analytics.read'],
    full: true,
  },
  quick: { id: 'quick', label: 'Quick actions', description: 'Your shortcuts', anyCaps: [] },
  views: {
    id: 'views',
    label: 'Page views, last 30 days',
    description: 'English and Arabic, day by day',
    anyCaps: ['analytics.read'],
  },
  leads: {
    id: 'leads',
    label: 'Latest inquiries',
    description: 'The newest 6 leads',
    anyCaps: ['leads.manage'],
  },
  attention: {
    id: 'attention',
    label: 'Needs attention',
    description: 'Going live today, placeholders, missing images and alt text',
    anyCaps: ['blog.write', 'services.write', 'seo.entityMeta'],
  },
  health: {
    id: 'health',
    label: 'Site health',
    description: 'The score and what fails',
    anyCaps: ['siteHealth.view'],
  },
  activity: {
    id: 'activity',
    label: 'Recent activity',
    description: 'Who changed what',
    anyCaps: ['audit.view'],
  },
  applications: {
    id: 'applications',
    label: 'Job applications',
    description: 'New applications waiting',
    anyCaps: ['applications.manage'],
  },
  pages: {
    id: 'pages',
    label: 'Top pages',
    description: 'Most visited in the last 7 days',
    anyCaps: ['analytics.read'],
  },
  disciplines: {
    id: 'disciplines',
    label: 'Leads by discipline',
    description: 'Where inquiries came from, last 90 days',
    anyCaps: ['leads.manage'],
  },
  notes: {
    id: 'notes',
    label: 'Team notes',
    description: 'A shared note for the team',
    anyCaps: ['analytics.read'],
  },
};

type Caps = Readonly<Record<Capability, Access>>;

/**
 * The widgets a set of capabilities shows, in the registry's order. No capability at all, no
 * widget (ui.md §10: "A role without caps gets an empty dashboard widget set").
 */
export function widgetsForCaps(caps: Caps): WidgetId[] {
  if (!CAPABILITIES.some((cap) => caps[cap] === 'full')) return [];
  return WIDGET_IDS.filter((id) => {
    const need = WIDGETS[id].anyCaps;
    return need.length === 0 || need.some((cap) => caps[cap] === 'full');
  });
}

/** The widgets a role sees (ROLE_CAPS decides). */
export function widgetsFor(role: Role): WidgetId[] {
  return widgetsForCaps(ROLE_CAPS[role]);
}

/**
 * The layout a role starts with when the person never arranged theirs and the owner set no
 * preset (the prototype's DASH_DEFAULT, per role). Ids the role may not see are dropped when
 * a layout is resolved, so these only order what each role has.
 */
export const DEFAULT_LAYOUTS: Readonly<Record<Role, DashboardLayout>> = {
  admin: {
    top: ['kpis'],
    left: ['quick', 'views', 'leads'],
    right: ['attention', 'health', 'activity', 'applications'],
    hidden: ['pages', 'disciplines', 'notes'],
  },
  content_creator: {
    top: ['kpis'],
    left: ['quick', 'views'],
    right: ['attention', 'pages'],
    hidden: ['notes'],
  },
  seo: {
    top: ['kpis'],
    left: ['quick', 'views'],
    right: ['attention', 'pages'],
    hidden: ['notes'],
  },
  developer: {
    top: ['kpis'],
    left: ['quick', 'views', 'leads'],
    right: ['health', 'activity'],
    hidden: ['pages', 'disciplines', 'notes'],
  },
};
