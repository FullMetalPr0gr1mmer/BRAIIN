import {
  LEAD_CHANNELS,
  LEAD_SORTS,
  LEAD_SOURCES,
  type LeadAssignedFilter,
  type LeadChannel,
  type LeadSource,
} from '@schemas/crm';
import { LEAD_RANGES, rangeToInstants, type LeadRange } from './leadView';

// The leads screens' filters in the address bar (Admin v2 C4b, crm.md §11: "Filter state lives
// in the URL except `q`"). Pure, for the pages' server render and the islands alike, so a
// reload, a shared link, Back from a lead and Previous/Next all mean the same filter.
//
//   ?stage=<uuid>|unread|spam  the chip: a stage, the unread leads, or the spam view
//   &assigned=me|none|<uuid>   whose leads ('me' is read in SQL as the session's user)
//   &source=  &channel=        where they came from (a channel matters for "Added by hand")
//   &discipline=<slug>         a service in it, or "help me choose" in it
//   &range=7|30|90             the last N days (all time when absent)
//   &sort=newest|oldest|score  starred first when absent (decision D6)
//   &page=N                    the list's page, 15 a page
//
// An allow-list: an unknown key, or a value outside a key's own list, is dropped, never passed
// on. The search box is never here, in either direction: a search term in an address lands in
// history, logs and Referer headers (verification D10). Every later read posts it in a body.

/** The list's page size (crm.md §11: 15 a page). */
export const LEADS_PAGE_SIZE = 15;

/** The deepest page the list API reaches (its offset stops at 10,000). */
const MAX_PAGE = Math.floor(10_000 / LEADS_PAGE_SIZE) + 1;

export type LeadSort = (typeof LEAD_SORTS)[number];
/** The list's default order: starred first, then newest (decision D6). */
export const DEFAULT_LEAD_SORT: LeadSort = 'starred';

/** Which chip is pressed: every lead, a stage, the unread ones, or the spam view. */
export type LeadChip =
  { kind: 'all' } | { kind: 'stage'; id: string } | { kind: 'unread' } | { kind: 'spam' };

export interface LeadFilters {
  chip: LeadChip;
  assigned: LeadAssignedFilter | null;
  source: LeadSource | null;
  channel: LeadChannel | null;
  discipline: string | null;
  range: LeadRange;
  sort: LeadSort;
  /** 1-based. */
  page: number;
}

export const DEFAULT_LEAD_FILTERS: LeadFilters = {
  chip: { kind: 'all' },
  assigned: null,
  source: null,
  channel: null,
  discipline: null,
  range: 'all',
  sort: DEFAULT_LEAD_SORT,
  page: 1,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A discipline's slug as app.lead_filter takes it (0063). */
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const oneOf = <T extends string>(list: readonly T[], value: string | null): T | null =>
  value !== null && (list as readonly string[]).includes(value) ? (value as T) : null;

/** The filters an address carries; anything it cannot read is left out. */
export function parseLeadFilters(params: URLSearchParams): LeadFilters {
  const stage = params.get('stage');
  const chip: LeadChip =
    stage === 'spam'
      ? { kind: 'spam' }
      : stage === 'unread'
        ? { kind: 'unread' }
        : stage !== null && UUID.test(stage)
          ? { kind: 'stage', id: stage.toLowerCase() }
          : { kind: 'all' };
  const assignedRaw = params.get('assigned');
  const assigned: LeadAssignedFilter | null =
    assignedRaw === 'me' || assignedRaw === 'none'
      ? assignedRaw
      : assignedRaw !== null && UUID.test(assignedRaw)
        ? assignedRaw.toLowerCase()
        : null;
  const disciplineRaw = params.get('discipline');
  const discipline =
    disciplineRaw !== null && disciplineRaw.length <= 64 && SLUG.test(disciplineRaw)
      ? disciplineRaw
      : null;
  const pageRaw = params.get('page');
  const page = pageRaw !== null && /^\d{1,4}$/.test(pageRaw) ? Number(pageRaw) : 1;
  return {
    chip,
    assigned,
    source: oneOf(LEAD_SOURCES, params.get('source')),
    channel: oneOf(LEAD_CHANNELS, params.get('channel')),
    discipline,
    range: oneOf(LEAD_RANGES, params.get('range')) ?? 'all',
    sort: oneOf(LEAD_SORTS, params.get('sort')) ?? DEFAULT_LEAD_SORT,
    page: Math.min(MAX_PAGE, Math.max(1, page)),
  };
}

/** The filters as an address's query, defaults left out, in one fixed order. */
export function leadFilterParams(filters: LeadFilters): URLSearchParams {
  const params = new URLSearchParams();
  const { chip } = filters;
  if (chip.kind === 'stage') params.set('stage', chip.id);
  else if (chip.kind !== 'all') params.set('stage', chip.kind);
  if (filters.assigned) params.set('assigned', filters.assigned);
  if (filters.source) params.set('source', filters.source);
  if (filters.channel) params.set('channel', filters.channel);
  if (filters.discipline) params.set('discipline', filters.discipline);
  if (filters.range !== 'all') params.set('range', filters.range);
  if (filters.sort !== DEFAULT_LEAD_SORT) params.set('sort', filters.sort);
  if (filters.page > 1) params.set('page', String(filters.page));
  return params;
}

/** `path` with the filters' query, or the bare path when every filter is its default. */
export function withLeadFilters(path: string, filters: LeadFilters): string {
  const query = leadFilterParams(filters).toString();
  return query ? `${path}?${query}` : path;
}

/** The same filters on the first page: what a lead's page carries back to the list. */
export function firstPage(filters: LeadFilters): LeadFilters {
  return { ...filters, page: 1 };
}

/** When the range starts (lead_summary's and leads_list's `from`), or undefined: all time. */
function rangeStart(filters: LeadFilters, now: Date): string | undefined {
  return rangeToInstants(filters.range, now)?.from;
}

/** The filters every reader shares: whose, where from, which discipline, since when. */
function shared(filters: LeadFilters, now: Date) {
  const out: {
    assigned?: LeadAssignedFilter;
    source?: LeadSource;
    channel?: LeadChannel;
    discipline?: string;
    from?: string;
  } = {};
  if (filters.assigned) out.assigned = filters.assigned;
  if (filters.source) out.source = filters.source;
  if (filters.channel) out.channel = filters.channel;
  if (filters.discipline) out.discipline = filters.discipline;
  const from = rangeStart(filters, now);
  if (from) out.from = from;
  return out;
}

/** The chip's part of a list filter: a stage, the unread leads or the spam view. */
function chipFilter(chip: LeadChip): { stage?: string; unread?: boolean; spam?: boolean } {
  if (chip.kind === 'stage') return { stage: chip.id };
  if (chip.kind === 'unread') return { unread: true };
  if (chip.kind === 'spam') return { spam: true };
  return {};
}

/**
 * POST /api/admin/leads/query's body for these filters (the search is added by the island,
 * in the body, never from the address).
 */
export function listQueryOf(filters: LeadFilters, now: Date) {
  return {
    ...chipFilter(filters.chip),
    ...shared(filters, now),
    sort: filters.sort,
    limit: LEADS_PAGE_SIZE,
    offset: (filters.page - 1) * LEADS_PAGE_SIZE,
  };
}

/** public.lead_neighbours' filter: the list's, with no search and no page (decision D8). */
export function neighboursQueryOf(filters: LeadFilters, now: Date) {
  return { ...chipFilter(filters.chip), ...shared(filters, now), sort: filters.sort };
}

/** The board's filter: every stage and no spam, so no chip, sort or page. */
export function boardQueryOf(filters: LeadFilters, now: Date, perStage = 50) {
  return { ...shared(filters, now), perStage };
}

/**
 * The KPIs' range: from midnight N-1 days ago to now, and nothing else (the KPIs and the chips
 * follow the range only, decision D13). Empty for all time.
 */
export function summaryQueryOf(filters: LeadFilters, now: Date): { from?: string; to?: string } {
  const range = rangeToInstants(filters.range, now);
  return range ? { from: range.from, to: range.to } : {};
}

/**
 * The server export for the filters on screen (crm.md §11: "No client-side CSV"): a link to
 * GET /api/admin/leads/export with the list's filters in their string form. Never the search.
 */
export function exportHrefOf(filters: LeadFilters, now: Date): string {
  const params = new URLSearchParams();
  const { stage, unread, spam } = chipFilter(filters.chip);
  const rest = shared(filters, now);
  if (rest.from) params.set('from', rest.from);
  if (stage) params.set('stage', stage);
  // The export leaves spam out unless asked, as the list does (src/lib/crm/exportRead.ts).
  if (spam) params.set('spam', 'true');
  if (unread) params.set('unread', 'true');
  if (rest.assigned) params.set('assigned', rest.assigned);
  if (rest.source) params.set('source', rest.source);
  if (rest.channel) params.set('channel', rest.channel);
  if (rest.discipline) params.set('discipline', rest.discipline);
  const query = params.toString();
  return query ? `/api/admin/leads/export?${query}` : '/api/admin/leads/export';
}
