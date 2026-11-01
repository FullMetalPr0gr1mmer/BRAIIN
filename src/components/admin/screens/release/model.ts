import type { Role } from '@/lib/auth/types';
import { ROLE_CAPS } from '@/lib/authz/matrix';
import type { Clock } from '@/lib/admin/relTime';
import { RELEASE_ENTITY_META } from '@/lib/release/areas';
import { addDays, todayIn, zonedInstant, zonedParts } from '@/lib/time/zone';
import { timeZoneCity } from '@schemas/timeZones';
import {
  RELEASE_AREAS,
  RELEASE_MAX_ITEMS,
  RELEASE_SCHEDULE_MAX_DAYS,
  RELEASE_SCHEDULE_MIN_MINUTES,
  type PendingItem,
  type PurgeStatus,
  type ReleaseArea,
  type ReleaseCheck,
  type ReleaseCheckItem,
  type ReleaseEntityType,
} from '@schemas/release';
import type { BadgeTone } from '@/lib/admin/tones';

// The savebar and the publish dialog's rules (Admin v2 R12; releases.md §7, the UX contract;
// README P-2: eligibility per item, P-12: the words). Pure, no React and no fetch, so every rule
// is unit-tested (tests/lib/releaseUiModel.spec.ts) and the kit gallery can draw the same
// islands over made-up changes. The server decides every publish: what is here is what the
// person is shown before they ask (the pending summary's `publishableByMe` and `waitingFor`,
// R3b), never a gate.

/** What GET /api/admin/releases/pending answers (R3b, with R12's additions). */
export interface PendingSummary {
  items: PendingItem[];
  total: number;
  truncated: boolean;
}

/** The change badge a row wears (releases.md §7). */
export type ChangeKind =
  'new' | 'changed' | 'published' | 'hidden' | 'shown' | 'archived' | 'removed' | 'reordered';

export const CHANGE_WORDS: Readonly<Record<ChangeKind, string>> = {
  new: 'New',
  changed: 'Changed',
  published: 'Published',
  hidden: 'Hidden',
  shown: 'Shown',
  archived: 'Archived',
  removed: 'Removed',
  reordered: 'Reordered',
};

export const CHANGE_TONES: Readonly<Record<ChangeKind, BadgeTone>> = {
  new: 'sky',
  changed: 'klein',
  published: 'ok',
  hidden: 'warn',
  shown: 'ok',
  archived: 'gray',
  removed: 'err',
  reordered: 'gray',
};

/** The areas in the words of the admin's menu. */
export const AREA_WORDS: Readonly<Record<ReleaseArea, string>> = {
  pages: 'Pages',
  services: 'Services',
  our_work: 'Our work',
  collections: 'Collections',
  blog: 'Creative Knowledge',
  navigation: 'Navigation',
  settings: 'Settings',
  appearance: 'Appearance',
  seo: 'SEO',
};

/** What one entity type is called in a reorder's row ("New order: Services"). */
const PLURAL: Readonly<Record<ReleaseEntityType, string>> = {
  category: 'Categories',
  sector: 'Sectors',
  client: 'Clients',
  team_member: 'Team',
  statistic: 'Numbers',
  certification: 'Certifications',
  discipline: 'Disciplines',
  service: 'Services',
  portfolio: 'Projects',
  service_case: 'Service cases',
  testimonial: 'Testimonials',
  blog_post: 'Posts',
  page: 'Pages',
  page_section: 'Sections',
  nav_item: 'Menu items',
  site_profile: 'Identity',
  custom_theme: 'Themes',
  entity_seo: 'Search settings',
  seo_defaults: 'Search defaults',
  redirect: 'Redirects',
  page_visibility: 'Page visibility',
  faq_item: 'Questions',
  form_settings: 'Forms',
};

/** One row of the dialog: a change, or every sort-only edit of one list ("reorders count once"). */
export interface ChangeRow {
  key: string;
  area: ReleaseArea;
  entityType: ReleaseEntityType;
  items: readonly PendingItem[];
  label: string;
  /** The Arabic label, when the change carries one (shown after the English). */
  labelAr: string | null;
  kind: ChangeKind;
  /** The changed fields in words: "Title, Intro, +2". */
  fieldsText: string;
  /** Every change in it is the person's to publish, and none is locked by a schedule. */
  publishable: boolean;
  scheduled: boolean;
  /** Who could publish it (the roles that may publish every change in it). */
  waitingFor: readonly Role[];
  /** The newest change's author and time. */
  author: string | null;
  updatedAt: string;
  /** Every change in it is the person's own. */
  mine: boolean;
  href: string | null;
}

/** A sort-only edit: R3a stages a reorder as one `sort_order` change per moved row. */
export function isReorder(item: PendingItem): boolean {
  return item.op === 'update' && item.fields.length === 1 && item.fields[0] === 'sort_order';
}

/** The badge a single change wears, from what it stores. */
export function changeKind(item: PendingItem): ChangeKind {
  if (item.op === 'create') return 'new';
  if (item.op === 'delete') return 'removed';
  if (item.status === 'archived') return 'archived';
  if (item.status === 'published') return 'published';
  if (item.status === 'draft') return 'hidden';
  if (item.visible === true) return 'shown';
  if (item.visible === false) return 'hidden';
  if (isReorder(item)) return 'reordered';
  return 'changed';
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

/** "Title, Intro, +2": at most two names, then how many more. */
export function fieldsText(labels: readonly string[]): string {
  if (labels.length === 0) return '';
  const shown = labels.slice(0, 2).join(', ');
  return labels.length > 2 ? `${shown}, +${labels.length - 2}` : shown;
}

/** The roles that may publish every one of these changes. */
function commonRoles(items: readonly PendingItem[]): Role[] {
  const [first, ...rest] = items;
  if (!first) return [];
  return (first.waitingFor as Role[]).filter((role) =>
    rest.every((item) => (item.waitingFor as string[]).includes(role)),
  );
}

function rowOf(key: string, items: readonly PendingItem[], reorder: boolean): ChangeRow {
  const first = items[0]!;
  const label = reorder
    ? `New order: ${PLURAL[first.entityType]}`
    : (text(first.label?.['en']) ?? text(first.label?.['ar']) ?? PLURAL[first.entityType]);
  const labelAr = reorder ? null : text(first.label?.['ar']);
  const scheduled = items.some((i) => i.scheduled);
  return {
    key,
    area: first.area,
    entityType: first.entityType,
    items,
    label,
    labelAr: labelAr && labelAr !== label ? labelAr : null,
    kind: reorder ? 'reordered' : changeKind(first),
    fieldsText: reorder
      ? `${items.length} moved`
      : fieldsText(first.fieldLabels.length > 0 ? first.fieldLabels : []),
    publishable: !scheduled && items.every((i) => i.publishableByMe),
    scheduled,
    waitingFor: commonRoles(items),
    author: first.updatedByName,
    updatedAt: first.updatedAt,
    mine: items.every((i) => i.mine),
    href: first.href,
  };
}

/**
 * The dialog's rows, grouped by area in the menu's order, newest first within an area (the
 * summary lists newest first). Every sort-only edit of one list is ONE row, "New order:
 * Services", which ticks and unticks as one.
 */
export function buildRows(items: readonly PendingItem[]): ChangeRow[] {
  // A reorder's row takes the place of its newest change; its other changes join it.
  const slots: ({ item: PendingItem } | { order: ReleaseEntityType })[] = [];
  const orders = new Map<ReleaseEntityType, PendingItem[]>();
  for (const item of items) {
    if (isReorder(item) && !item.scheduled) {
      const list = orders.get(item.entityType);
      if (list) list.push(item);
      else {
        orders.set(item.entityType, [item]);
        slots.push({ order: item.entityType });
      }
    } else {
      slots.push({ item });
    }
  }
  const built = slots.map((slot) =>
    'item' in slot
      ? rowOf(slot.item.draftId, [slot.item], false)
      : rowOf(`order:${slot.order}`, orders.get(slot.order)!, true),
  );
  const areaAt = (area: ReleaseArea) => RELEASE_AREAS.indexOf(area);
  return built
    .map((row, index) => ({ row, index }))
    .sort((a, b) => areaAt(a.row.area) - areaAt(b.row.area) || a.index - b.index)
    .map(({ row }) => row);
}

/** The rows by area, in the menu's order, each area once. */
export function rowsByArea(rows: readonly ChangeRow[]): { area: ReleaseArea; rows: ChangeRow[] }[] {
  const out: { area: ReleaseArea; rows: ChangeRow[] }[] = [];
  for (const row of rows) {
    const last = out[out.length - 1];
    if (last && last.area === row.area) last.rows.push(row);
    else out.push({ area: row.area, rows: [row] });
  }
  return out;
}

// ---- the savebar ------------------------------------------------------------------------------

export interface SavebarCounts {
  /** Rows the person may publish. */
  publishable: number;
  /** Rows waiting for someone who can publish them. */
  waiting: number;
  /** Rows locked by a scheduled release. */
  scheduled: number;
  /** The person's own unscheduled changes ("Discard my changes (k)"), counted as changes. */
  mine: number;
  /** Rows the person may publish, per area. */
  byArea: Partial<Record<ReleaseArea, number>>;
}

export function savebarCounts(rows: readonly ChangeRow[]): SavebarCounts {
  const counts: SavebarCounts = { publishable: 0, waiting: 0, scheduled: 0, mine: 0, byArea: {} };
  for (const row of rows) {
    if (row.scheduled) counts.scheduled += 1;
    else if (row.publishable) {
      counts.publishable += 1;
      counts.byArea[row.area] = (counts.byArea[row.area] ?? 0) + 1;
    } else counts.waiting += 1;
    counts.mine += row.items.filter((i) => i.mine && !i.scheduled).length;
  }
  return counts;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The bar's first line. */
export function savebarLead(counts: SavebarCounts): string {
  if (counts.publishable > 0) {
    return `You have ${plural(counts.publishable, 'unpublished change')}`;
  }
  if (counts.waiting > 0) {
    return `${plural(counts.waiting, 'unpublished change')} waiting for someone who can publish ${counts.waiting === 1 ? 'it' : 'them'}`;
  }
  return counts.scheduled > 0
    ? `${plural(counts.scheduled, 'change')} scheduled to go live`
    : 'No unpublished changes';
}

/** The bar's second line: "2 in Pages · 1 in Services · +1 waiting for someone who can publish". */
export function savebarSub(counts: SavebarCounts): string {
  const parts = RELEASE_AREAS.flatMap((area) => {
    const n = counts.byArea[area] ?? 0;
    return n > 0 ? [`${n} in ${AREA_WORDS[area]}`] : [];
  });
  if (counts.publishable > 0 && counts.waiting > 0) {
    parts.push(`+${counts.waiting} waiting for someone who can publish`);
  }
  return parts.join(' · ');
}

/** True when the bar has anything to say. */
export function savebarShown(counts: SavebarCounts): boolean {
  return counts.publishable + counts.waiting + counts.scheduled > 0;
}

// ---- who may do what (UX only: the server decides again) --------------------------------------

/** May this role throw away a change of this type (its author capabilities, `app.can_author`)? */
export function mayDiscard(role: Role, item: PendingItem): boolean {
  return RELEASE_ENTITY_META[item.entityType].authorCaps.every(
    (cap) => ROLE_CAPS[role][cap] === 'full',
  );
}

const WHO: Readonly<Record<Role, string>> = {
  admin: 'an Admin',
  content_creator: 'a Content Creator',
  seo: 'SEO',
  developer: 'a Developer',
  sales: 'Sales',
};

/** "an Admin", "an Admin or a Developer", "an Admin, a Content Creator or SEO". */
export function whoWords(roles: readonly Role[]): string {
  const names = roles.map((role) => WHO[role]);
  if (names.length === 0) return 'no role';
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

/** A waiting row's line: "Needs an Admin". */
export function waitingWords(row: ChangeRow): string {
  if (row.scheduled) return 'Scheduled: locked until it goes live';
  return row.waitingFor.length === 0
    ? 'No role can publish this as it stands'
    : `Needs ${whoWords(row.waitingFor)}`;
}

// ---- the selection ------------------------------------------------------------------------------

/** The drafts of the rows, as the publish request names them. */
export function refsOf(rows: readonly ChangeRow[], ids: ReadonlySet<string>) {
  return rows.flatMap((row) =>
    row.items
      .filter((item) => ids.has(item.draftId))
      .map((item) => ({ draftId: item.draftId, draftVersion: item.draftVersion })),
  );
}

/**
 * Everything the person may publish, ticked (owner default O-4), up to one release (60
 * changes, P-15): rows are taken in order and never split, so a long list ticks its first rows
 * and says the rest wait for the next publish (`capped`).
 */
export function defaultSelection(
  rows: readonly ChangeRow[],
  max: number = RELEASE_MAX_ITEMS,
): { ids: Set<string>; capped: boolean } {
  const ids = new Set<string>();
  let capped = false;
  for (const row of rows) {
    if (!row.publishable) continue;
    if (ids.size + row.items.length > max) {
      capped = true;
      continue;
    }
    for (const item of row.items) ids.add(item.draftId);
  }
  return { ids, capped };
}

/** The row a draft belongs to. */
export function rowOfDraft(rows: readonly ChangeRow[], draftId: string): ChangeRow | undefined {
  return rows.find((row) => row.items.some((item) => item.draftId === draftId));
}

/** Per selected change, the pending changes it needs (from the check's `requires`). */
export type Needs = ReadonlyMap<string, readonly string[]>;

export function needsOf(check: ReleaseCheck | null): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const item of check?.items ?? []) {
    if (item.requires.length > 0)
      out.set(
        item.draftId,
        item.requires.map((r) => r.draftId),
      );
  }
  return out;
}

/**
 * Ticks what the selection needs (the check's `requires`): each needed change the person may
 * publish joins, with its whole row ("Included because 'X' needs it", `includedBecause`). A
 * change the person unticked themselves (`unticked`) is never ticked back: the changes that
 * need it leave the selection with it instead ("Unticking one unticks its dependants", which
 * the check can only say once it has seen the selection without it). A needed change the
 * person may not publish stays out, and the check keeps its dependant's error.
 */
export function withNeeds(
  rows: readonly ChangeRow[],
  ids: ReadonlySet<string>,
  needs: Needs,
  unticked: ReadonlySet<string> = new Set(),
): { ids: Set<string>; added: string[]; dropped: string[] } {
  let next = new Set(ids);
  const added: string[] = [];
  const dropped: string[] = [];
  let moved = true;
  while (moved) {
    moved = false;
    for (const [dependant, needed] of needs) {
      if (!next.has(dependant)) continue;
      const refused = needed.find((draftId) => !next.has(draftId) && unticked.has(draftId));
      if (refused !== undefined) {
        const row = rowOfDraft(rows, dependant);
        if (row) next = toggleRow(rows, next, row, false, needs);
        else next.delete(dependant);
        dropped.push(dependant);
        moved = true;
        continue;
      }
      for (const draftId of needed) {
        if (next.has(draftId)) continue;
        const row = rowOfDraft(rows, draftId);
        if (!row?.publishable) continue;
        for (const item of row.items) next.add(item.draftId);
        added.push(draftId);
        moved = true;
      }
    }
  }
  return { ids: next, added, dropped };
}

/** How many rows the selection holds whole (a reorder of a list is one, as the bar counts). */
export function selectedRows(rows: readonly ChangeRow[], ids: ReadonlySet<string>): number {
  return rows.filter(
    (row) => row.items.length > 0 && row.items.every((item) => ids.has(item.draftId)),
  ).length;
}

/** Ticks or unticks one row; unticking also unticks every selected change that needs it. */
export function toggleRow(
  rows: readonly ChangeRow[],
  ids: ReadonlySet<string>,
  row: ChangeRow,
  on: boolean,
  needs: Needs,
): Set<string> {
  const next = new Set(ids);
  if (on) {
    if (!row.publishable) return next;
    for (const item of row.items) next.add(item.draftId);
    return next;
  }
  const gone = new Set(row.items.map((item) => item.draftId));
  for (const id of gone) next.delete(id);
  let shrank = true;
  while (shrank) {
    shrank = false;
    for (const [dependant, needed] of needs) {
      if (!next.has(dependant) || !needed.some((id) => gone.has(id))) continue;
      const dependantRow = rowOfDraft(rows, dependant);
      for (const item of dependantRow?.items ?? []) {
        next.delete(item.draftId);
        gone.add(item.draftId);
      }
      shrank = true;
    }
  }
  return next;
}

/** "Included because “Logo Design” needs it", for a change the selection pulled in. */
export function includedBecause(
  rows: readonly ChangeRow[],
  ids: ReadonlySet<string>,
  row: ChangeRow,
  needs: Needs,
): string | null {
  const mine = new Set(row.items.map((item) => item.draftId));
  const by = [...needs]
    .filter(([dependant, needed]) => ids.has(dependant) && needed.some((id) => mine.has(id)))
    .map(([dependant]) => rowOfDraft(rows, dependant)?.label)
    .filter((label): label is string => typeof label === 'string' && label !== row.label);
  if (by.length === 0) return null;
  const names = [...new Set(by)].map((label) => `“\u2068${label}\u2069”`);
  return `Included because ${names.join(' and ')} ${names.length === 1 ? 'needs' : 'need'} it`;
}

// ---- the check, per row ---------------------------------------------------------------------------

export type RowState = 'unchecked' | 'ready' | 'warning' | 'error' | 'conflict';

export interface RowCheck {
  state: RowState;
  /** What stops it, or what to know, in the server's words. */
  messages: string[];
  /** The columns the live site moved in (a conflict). */
  conflict: { draftId: string; columns: string[] } | null;
  /** The live row is gone under the change. */
  removed: boolean;
}

/** One row's state from the check: an error first, then a conflict, then a warning. */
export function rowCheck(row: ChangeRow, check: ReleaseCheck | null): RowCheck {
  const mine = new Set(row.items.map((item) => item.draftId));
  const items: ReleaseCheckItem[] = (check?.items ?? []).filter((i) => mine.has(i.draftId));
  if (items.length === 0)
    return { state: 'unchecked', messages: [], conflict: null, removed: false };
  const conflictItem = items.find((i) => i.conflict);
  const conflict =
    conflictItem?.conflict && 'columns' in conflictItem.conflict
      ? { draftId: conflictItem.draftId, columns: conflictItem.conflict.columns }
      : null;
  const removed = items.some((i) => i.conflict && 'removed' in i.conflict);
  const errors = items.flatMap((i) => i.errors.filter((e) => e.code !== 'conflict'));
  if (errors.length > 0) {
    return {
      state: 'error',
      messages: [...new Set(errors.map((e) => e.message))],
      conflict,
      removed,
    };
  }
  if (conflict || removed) {
    return { state: 'conflict', messages: [], conflict, removed };
  }
  const warnings = items.flatMap((i) => i.warnings.map((w) => w.message));
  if (warnings.length > 0) {
    return { state: 'warning', messages: [...new Set(warnings)], conflict: null, removed: false };
  }
  return { state: 'ready', messages: [], conflict: null, removed: false };
}

// ---- the words of an outcome ----------------------------------------------------------------------

/** The toast after a publish (toasts are for success only: a purge left owing says so here). */
export function publishedWords(number: number, purge: PurgeStatus): string {
  if (purge === 'pending') {
    return `Published v${number}. Some pages may show the old version for a few minutes.`;
  }
  if (purge === 'failed') {
    return `Published v${number}. The website’s cache could not be refreshed yet: it tries again by itself every minute.`;
  }
  return `Published v${number}. The website now shows these changes.`;
}

/**
 * A retry by hand that failed again (R13; the card and Backups & versions): the minute cron tries
 * it by itself only while the version has attempts left (ten, RELEASE_PURGE_MAX_ATTEMPTS), and a
 * retry by hand uses one of them, so past the tenth the words say so (review R13-C3).
 */
export function purgeFailedAgainWords(autoRetry: boolean): string {
  return autoRetry
    ? 'The website cache still couldn’t be refreshed. It’s tried again by itself in a few minutes.'
    : 'The website cache still couldn’t be refreshed, and it won’t be tried again by itself. Try again later, or ask whoever runs the site to check the cache.';
}

/** What the edge not taking a release's redirects or visibility means, and what to do. */
export const EDGE_MISSED =
  'The redirect and page visibility rules did not reach the edge yet. They are rebuilt every day; to do it now, use Sync to edge on the SEO screen.';

export const COPY = {
  publishTitle: 'Publish to the website',
  publishSub: 'Everything ticked goes live together.',
  reviewTitle: 'Unpublished changes',
  reviewSub: 'They wait for someone who can publish them. Nothing here is live yet.',
  discardTitle: 'Discard changes',
  discardSub: 'Tick what to throw away. The live site doesn’t change.',
  capped: `At most ${RELEASE_MAX_ITEMS} changes go live together. The first ones are ticked: publish again for the rest.`,
  pendingChanged:
    'Some changes moved since you opened this. The list is up to date now: check it, then publish again.',
  releasesOff: 'Publishing is switched off: every save goes live at once.',
  busy: 'Someone else is publishing, or the site is busy. Try again in a moment.',
  checking: 'Checking…',
  ready: 'Ready',
  noteLabel: 'Note (optional), shown in Versions',
  removedLive: 'This item was removed on the live site. Discard the change.',
  conflictLead: 'Changed on the live site since this edit started',
  whenLegend: 'When',
  whenNow: 'Now',
  whenSchedule: 'Schedule for',
  dayLabel: 'Day',
  timeLabel: 'Time',
  // The publish endpoint's own words for a time outside its bounds (src/lib/release/
  // endpoints.ts SCHEDULE_COPY, held equal by tests/lib/releaseUiModel.spec.ts), so the dialog
  // and the server say the same thing whichever of them notices first.
  scheduleTooSoon: `Choose a time at least ${RELEASE_SCHEDULE_MIN_MINUTES} minutes from now.`,
  scheduleTooLate: 'Choose a time within the next year.',
  scheduleIncomplete: 'Choose a day and a time.',
} as const;

// ---- the schedule ("When: Now | Schedule for [day] [time]", releases.md §7; R11's server) -------

export type When = 'now' | 'schedule';

const DAY_INPUT = /^(\d{4})-(\d{2})-(\d{2})$/;
// A time input answers "HH:MM", or "HH:MM:SS" when it has a step under a minute.
const TIME_INPUT = /^(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/;

/**
 * The instant a day and a time on the studio's clock name (`zone`: the studio's, Riyadh by
 * default), or null while either is incomplete or not a real day. The browser's own zone plays
 * no part: a date and a time input are wall-clock readings, placed in the studio's zone here.
 */
export function scheduleInstant(zone: string, day: string, time: string): Date | null {
  const d = DAY_INPUT.exec(day);
  const t = TIME_INPUT.exec(time);
  if (!d || !t) return null;
  const [year, month, date] = [Number(d[1]), Number(d[2]), Number(d[3])];
  const [hour, minute] = [Number(t[1]), Number(t[2])];
  if (hour > 23 || minute > 59) return null;
  // A day that does not exist (31 Feb) is no day, not the one Date.UTC would roll it into.
  const check = new Date(Date.UTC(year, month - 1, date));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== date
  ) {
    return null;
  }
  return zonedInstant(zone, year, month, date, hour, minute);
}

/**
 * What stops a scheduled time, in the endpoint's words, or null when it is fine: at least
 * RELEASE_SCHEDULE_MIN_MINUTES ahead, at most RELEASE_SCHEDULE_MAX_DAYS. UX only: the
 * endpoint judges again against its own clock (and the database, 1 minute to 366 days).
 */
export function scheduleProblem(at: Date | null, now: number): string | null {
  if (!at) return COPY.scheduleIncomplete;
  if (at.getTime() < now + RELEASE_SCHEDULE_MIN_MINUTES * 60_000) return COPY.scheduleTooSoon;
  if (at.getTime() > now + RELEASE_SCHEDULE_MAX_DAYS * 86_400_000) return COPY.scheduleTooLate;
  return null;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** The day and time inputs' values for an instant, on the studio's clock. */
export function slotOf(at: Date, zone: string): { day: string; time: string } {
  const p = zonedParts(at, zone);
  return {
    day: `${p.year}-${pad2(p.month)}-${pad2(p.day)}`,
    time: `${pad2(p.hour)}:${pad2(p.minute)}`,
  };
}

/**
 * The time "Schedule for" starts at: the first whole hour on the studio's clock at least half
 * an hour from now (14:05 gives 15:00, 14:40 gives 16:00), well clear of the 2-minute floor.
 */
export function defaultScheduleSlot(zone: string, now: number): { day: string; time: string } {
  const p = zonedParts(now + 30 * 60_000, zone);
  const roundUp = p.minute > 0 || p.second > 0 ? 1 : 0;
  // zonedInstant takes hour 24 as the next day's midnight (Date.UTC carries it).
  return slotOf(zonedInstant(zone, p.year, p.month, p.day, p.hour + roundUp, 0), zone);
}

/** The day input's bounds: today on the studio's clock to a year ahead. */
export function scheduleDayBounds(zone: string, now: number): { min: string; max: string } {
  const today = todayIn(zone, now);
  return { min: today, max: addDays(today, RELEASE_SCHEDULE_MAX_DAYS) };
}

/** "Riyadh time": the studio's zone named by its city, beside the time input. */
export function zoneWords(zone: string): string {
  return `${timeZoneCity(zone)} time`;
}

/**
 * The outcome of a schedule (releases.md §7): "Scheduled for 12 Oct 2026, 14:00 (Riyadh).
 * These changes are locked until then." A success, so a toast.
 */
export function scheduledWords(at: string, clock: Clock): string {
  return `Scheduled for ${clock.formatDateTime(at)} (${timeZoneCity(clock.zone)}). These changes are locked until then.`;
}

/** "Discard my changes" and "Discard selected" confirmations (releases.md §7). */
export function discardMineWords(count: number): string {
  return `Discard your unpublished changes? ${plural(count, 'change')} you made since the last publish will be thrown away. The live site doesn’t change.`;
}

export function discardSelectedWords(rows: readonly ChangeRow[], ids: ReadonlySet<string>): string {
  const chosen = rows.flatMap((row) => row.items.filter((item) => ids.has(item.draftId)));
  const others = chosen.filter((item) => !item.mine);
  const names = [...new Set(others.map((item) => item.updatedByName ?? 'someone else'))];
  // Counted as the bar and the dialog count: a reordered list is one change.
  const lead = `Discard ${plural(selectedRows(rows, ids), 'change')}?`;
  if (others.length === 0) {
    return `${lead} They will be thrown away. The live site doesn’t change. This can’t be undone.`;
  }
  return `${lead} This includes ${plural(others.length, 'change')} by ${names.join(', ')}. They will be lost. The live site doesn’t change. This can’t be undone.`;
}

/** The address that previews a selection (R9's `only`, at most 500 ids). */
export function previewHref(ids: ReadonlySet<string>): string {
  const list = [...ids].slice(0, 500);
  return list.length > 0 ? `/admin/preview/?only=${list.join(',')}` : '/admin/preview/';
}
