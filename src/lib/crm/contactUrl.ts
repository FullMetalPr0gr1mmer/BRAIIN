import {
  CONTACT_SORTS,
  CONTACT_STAGES,
  type ContactQuery,
  type ContactStage,
  type LeadAssignedFilter,
} from '@schemas/crm';

// The People list's filters in the address bar (Admin v2 C7, crm.md §11: "Filter state lives in
// the URL except `q`"). Pure, for the page's server render and the island alike, so a reload,
// a shared link and Back from a contact all mean the same filter.
//
//   ?stage=lead|client|past|partner|starred|expiring   the chip that is pressed
//   &owner=me|none|<uuid>                               whose contacts ('me' is read in SQL as
//                                                       the session's user)
//   &sort=name|starred|oldest                           the most recently active first when absent
//   &page=N                                             the list's page, 20 a page
//
// An allow-list: an unknown key, or a value outside a key's own list, is dropped. The search
// box and the tag box are never here, in either direction: a search term can be an e-mail
// address, and a tag is words staff type, which can name a person (verification D10; crm.md
// §11: "URLs carry ids, never names or e-mails"). Both are posted in a body.

/** The list's page size (crm.md §11: 20 a page). */
export const CONTACTS_PAGE_SIZE = 20;

/** The deepest page the list API reaches (its offset stops at 10,000). */
const MAX_PAGE = Math.floor(10_000 / CONTACTS_PAGE_SIZE) + 1;

export type ContactSort = (typeof CONTACT_SORTS)[number];
/** The list's default order: the most recently active first. */
export const DEFAULT_CONTACT_SORT: ContactSort = 'recent';

/** Which chip is pressed: everyone, a stage, the starred, or those whose time is nearly up. */
export type ContactChip = 'all' | ContactStage | 'starred' | 'expiring';
const CHIPS: readonly ContactChip[] = [...CONTACT_STAGES, 'starred', 'expiring'];

export interface ContactFilters {
  chip: ContactChip;
  owner: LeadAssignedFilter | null;
  sort: ContactSort;
  /** 1-based. */
  page: number;
}

export const DEFAULT_CONTACT_FILTERS: ContactFilters = {
  chip: 'all',
  owner: null,
  sort: DEFAULT_CONTACT_SORT,
  page: 1,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const oneOf = <T extends string>(list: readonly T[], value: string | null): T | null =>
  value !== null && (list as readonly string[]).includes(value) ? (value as T) : null;

/** The filters an address carries; anything it cannot read is left out. */
export function parseContactFilters(params: URLSearchParams): ContactFilters {
  const ownerRaw = params.get('owner');
  const owner: LeadAssignedFilter | null =
    ownerRaw === 'me' || ownerRaw === 'none'
      ? ownerRaw
      : ownerRaw !== null && UUID.test(ownerRaw)
        ? ownerRaw.toLowerCase()
        : null;
  const pageRaw = params.get('page');
  const page = pageRaw !== null && /^\d{1,4}$/.test(pageRaw) ? Number(pageRaw) : 1;
  return {
    chip: oneOf(CHIPS, params.get('stage')) ?? 'all',
    owner,
    sort: oneOf(CONTACT_SORTS, params.get('sort')) ?? DEFAULT_CONTACT_SORT,
    page: Math.min(MAX_PAGE, Math.max(1, page)),
  };
}

/** `path` with the filters' query (defaults left out, one fixed order), or the bare path. */
export function withContactFilters(path: string, filters: ContactFilters): string {
  const params = new URLSearchParams();
  if (filters.chip !== 'all') params.set('stage', filters.chip);
  if (filters.owner) params.set('owner', filters.owner);
  if (filters.sort !== DEFAULT_CONTACT_SORT) params.set('sort', filters.sort);
  if (filters.page > 1) params.set('page', String(filters.page));
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

/**
 * POST /api/admin/crm/contacts/query's body for these filters. The search and the tag are the
 * island's, added in the body, never read from the address.
 */
export function contactQueryOf(
  filters: ContactFilters,
  typed: { q?: string; tag?: string } = {},
): ContactQuery {
  const body: ContactQuery = {
    sort: filters.sort,
    limit: CONTACTS_PAGE_SIZE,
    offset: (filters.page - 1) * CONTACTS_PAGE_SIZE,
  };
  if (filters.chip === 'starred') body.starred = true;
  else if (filters.chip === 'expiring') body.expiring = true;
  else if (filters.chip !== 'all') body.stage = filters.chip;
  if (filters.owner) body.owner = filters.owner;
  if (typed.q) body.q = typed.q;
  if (typed.tag) body.tag = typed.tag;
  return body;
}
