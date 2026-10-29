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
import { DEFAULT_LAYOUTS, RELEASE_WIDGETS, widgetsFor } from './widgets';

// Which layout and which quick actions a person sees (Admin v2 U1, README U1 D2): their own,
// else their role's preset (admin_role_defaults, 0060), else the code's default; then every id
// the role may not use is dropped, so a preference never grants access (ui.md §4), and every
// widget the role sees but the layout does not mention is kept off the board, in `hidden`, so
// "Add widget" can offer it (the prototype's dashLayout()).
//
// One exception (Admin v2 R14-prep, R13's open item): a RELEASE widget (the publish card) that a
// stored layout or role preset names NOWHERE, no column and not hidden, takes its place from the
// role's default layout. While releases are off the dashboard strips the release widgets from
// the board, Add widget and every save (R13), so a layout saved then never names them; without
// this the card would arrive hidden for everyone who had arranged their dashboard before the
// switch-on. A layout that names it (moved, or hidden by the person) keeps it where it is. Every
// other widget keeps the rule above, and with releases off the page strips the card again, so
// the dashboard is unchanged then.
//
// Its other half (R14-prep code review 1): a SAVE that names a release widget nowhere keeps the
// widget where the stored layout had it (keepReleasePlacement, below; the person's own save and
// an Admin's role preset). The board a save comes from never shows the card while releases are
// off, so without this a person who hid it, saved their board while releases were off, and saw
// releases come back on would find it on their board again, their hide forgotten.

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
  for (const id of RELEASE_WIDGETS) {
    if (allowed.has(id) && !seen.has(id) && placeAsDefault(layout, id, role)) seen.add(id);
  }
  for (const id of allowed) if (!seen.has(id)) layout.hidden.push(id);
  return { layout, source };
}

/**
 * The release widgets the role may have that a whole layout about to be saved names nowhere
 * (none for a "Reset", which names no column): what keepReleasePlacement puts back.
 */
export function unnamedReleaseWidgets(next: DashboardPrefLists, role: Role): WidgetId[] {
  if (!DASH_LISTS.every((key) => Array.isArray(next[key]))) return [];
  const allowed = new Set(widgetsFor(role));
  const named = new Set(DASH_LISTS.flatMap((key) => next[key] ?? []));
  return RELEASE_WIDGETS.filter((id) => allowed.has(id) && !named.has(id));
}

/**
 * A layout about to be saved, with each release widget it names nowhere put back where `stored`
 * (the row it replaces) had it: the same column at the same index (or last, in a shorter column),
 * or hidden. A widget `stored` never named either stays unnamed, so it takes its default place
 * once releases are on (resolveLayout). Only a whole layout is touched (a "Reset" names no
 * column and replaces everything), and only widgets the role may have; `quickSet` is the save's.
 */
export function keepReleasePlacement<T extends DashboardPrefLists>(
  next: T,
  stored: unknown,
  role: Role,
): T {
  const missing = unnamedReleaseWidgets(next, role);
  if (missing.length === 0 || !hasColumns(stored)) return next;
  const before = readDashboardLayout(stored);
  const out: T = { ...next };
  for (const key of DASH_LISTS) out[key] = [...(next[key] ?? [])] as T[typeof key];
  for (const id of missing) {
    for (const key of DASH_LISTS) {
      const at = before[key].indexOf(id);
      if (at < 0) continue;
      const list = out[key] as WidgetId[];
      list.splice(Math.min(at, list.length), 0, id);
      break;
    }
  }
  return out;
}

const DASH_LISTS = [...DASH_COLUMNS, 'hidden'] as const;

/** A layout's four lists, each present (a whole layout) or none (a "Reset"). */
type DashboardPrefLists = {
  [K in (typeof DASH_COLUMNS)[number] | 'hidden']?: WidgetId[] | undefined;
};

/**
 * Puts a widget the layout never named where the role's default layout has it: its column, at
 * its index there (or last, in a shorter column). False when the default board does not show it.
 */
function placeAsDefault(layout: DashboardLayout, id: WidgetId, role: Role): boolean {
  const defaults = DEFAULT_LAYOUTS[role];
  for (const column of DASH_COLUMNS) {
    const at = defaults[column].indexOf(id);
    if (at < 0) continue;
    layout[column].splice(Math.min(at, layout[column].length), 0, id);
    return true;
  }
  return false;
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
