import {
  DASH_COLUMNS,
  hasColumns,
  isCustomItem,
  readDashboardLayout,
  readQuickActions,
  type DashboardLayout,
  type QuickItem,
  type WidgetId,
} from '@schemas/dashboard';
import type { Role } from '@/lib/auth/types';
import { libraryAction, mayUse, QUICK_DEFAULTS } from '../quickActions';
import { DEFAULT_LAYOUTS, widgetsFor } from './widgets';

// Which layout and which quick actions a person sees (Admin v2 U1, README U1 D2): their own,
// else their role's preset (admin_role_defaults, 0060), else the code's default; then every id
// the role may not use is dropped, so a preference never grants access (ui.md §4), and every
// widget the role sees but the layout does not mention is kept off the board, in `hidden`, so
// "Add widget" can offer it (the prototype's dashLayout()).

export type LayoutSource = 'mine' | 'preset' | 'default';

export interface ResolvedLayout {
  layout: DashboardLayout;
  source: LayoutSource;
}

/** The layout a role sees, from its sources in order (stored values are read leniently). */
export function resolveLayout(stored: unknown, preset: unknown, role: Role): ResolvedLayout {
  const source: LayoutSource = hasColumns(stored)
    ? 'mine'
    : hasColumns(preset)
      ? 'preset'
      : 'default';
  const raw =
    source === 'mine'
      ? readDashboardLayout(stored)
      : source === 'preset'
        ? readDashboardLayout(preset)
        : DEFAULT_LAYOUTS[role];
  const allowed = new Set(widgetsFor(role));
  const seen = new Set<WidgetId>();
  const keep = (ids: readonly WidgetId[]) =>
    ids.filter((id) => allowed.has(id) && !seen.has(id) && Boolean(seen.add(id)));
  const layout: DashboardLayout = {
    top: keep(raw.top),
    left: keep(raw.left),
    right: keep(raw.right),
    hidden: keep(raw.hidden),
  };
  for (const id of allowed) if (!seen.has(id)) layout.hidden.push(id);
  return { layout, source };
}

/**
 * A layout with these widgets taken off it, the hidden list included (R13: the publish card
 * while releases are off, so neither the board, Add widget nor a save names it).
 */
export function withoutWidgets(
  layout: DashboardLayout,
  drop: readonly WidgetId[],
): DashboardLayout {
  const keep = (ids: readonly WidgetId[]) => ids.filter((id) => !drop.includes(id));
  return {
    ...layout,
    top: keep(layout.top),
    left: keep(layout.left),
    right: keep(layout.right),
    hidden: keep(layout.hidden),
  };
}

/** The widgets a layout shows, in board order. */
export const shownWidgets = (layout: DashboardLayout): WidgetId[] =>
  DASH_COLUMNS.flatMap((column) => layout[column]);

/** The ids of a layout the role may not see (a save naming one is refused, 422). */
export function forbiddenWidgets(
  layout: { [K in (typeof DASH_COLUMNS)[number] | 'hidden']?: readonly WidgetId[] | undefined },
  role: Role,
): WidgetId[] {
  const allowed = new Set(widgetsFor(role));
  return [...DASH_COLUMNS, 'hidden' as const]
    .flatMap((key) => layout[key] ?? [])
    .filter((id) => !allowed.has(id));
}

/**
 * The library ids of a list the role may not use, or that the library does not know (a save
 * naming one is refused, 422). A person's own links are not library actions.
 */
export function forbiddenActions(items: readonly QuickItem[], role: Role): string[] {
  return items
    .filter((item) => !isCustomItem(item))
    .map((item) => item.id)
    .filter((id) => {
      const action = libraryAction(id);
      return !action || !mayUse(role, action);
    });
}

export type QuickSource = LayoutSource;

export interface ResolvedQuick {
  items: QuickItem[];
  source: QuickSource;
}

/**
 * The quick actions a person sees: their own list once they chose (`quickSet`, D8: an empty
 * list honoured), else the preset's when the owner set its quick actions, else the role's
 * default; library ids the role may not use, or that are gone, are dropped.
 */
export function resolveQuick(
  storedDashboard: unknown,
  storedQuick: unknown,
  presetDashboard: unknown,
  presetQuick: unknown,
  role: Role,
): ResolvedQuick {
  const mine = readDashboardLayout(storedDashboard).quickSet === true;
  const preset = !mine && readDashboardLayout(presetDashboard).quickSet === true;
  const source: QuickSource = mine ? 'mine' : preset ? 'preset' : 'default';
  const raw: QuickItem[] = mine
    ? readQuickActions(storedQuick)
    : preset
      ? readQuickActions(presetQuick).filter((item) => !isCustomItem(item))
      : QUICK_DEFAULTS[role].map((id) => ({ id }));
  const items = raw.filter((item) => {
    if (isCustomItem(item)) return true;
    const action = libraryAction(item.id);
    return action !== undefined && mayUse(role, action);
  });
  return { items, source };
}
