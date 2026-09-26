import type { LocalizedText } from '@schemas/content';
import type { PortfolioCard } from '@/lib/data/portfolio';

// The ONE facet module for Our Work and All projects (`/portfolio`, `/portfolio/all`):
// reading the query, filtering, the options a filter bar offers, and the orders the pages
// use. Server-side, so a filtered catalogue is real HTML without JS; the enhancement
// only replaces the URL (replaceState) and never builds markup from the query.
//
// The query is untrusted input, so it is reduced to KNOWN values before anything uses it:
// a facet value that no published project carries is dropped (a `?year=<img …>` is just
// "no year filter"), and the first value of a repeated key wins. Facets are fixed in code.

export const FACETS = ['service', 'sector', 'client', 'year'] as const;
export type Facet = (typeof FACETS)[number];
export type FacetSelection = Partial<Record<Facet, string>>;

const YEAR = /^\d{4}$/;

/** The values a card carries for a facet (a project has several services). */
export function valuesOf(card: PortfolioCard, facet: Facet): string[] {
  switch (facet) {
    case 'service':
      return card.services.map((s) => s.slug);
    case 'sector':
      return card.sector ? [card.sector.slug] : [];
    case 'client':
      // A confidential client is not a filterable value — naming it in a URL would disclose it.
      return card.client ? [card.client.slug] : [];
    case 'year':
      return card.year !== null ? [String(card.year)] : [];
  }
}

/**
 * The facet selection in a query string, reduced to values the given cards carry. Any
 * facet key present with a non-empty value makes the page uncacheable (see isFiltered).
 */
export function parseFacets(
  params: URLSearchParams,
  cards: readonly PortfolioCard[],
): FacetSelection {
  const selection: FacetSelection = {};
  for (const facet of FACETS) {
    const raw = params.get(facet); // the first value wins
    if (!raw) continue;
    const value = raw.trim().toLowerCase();
    if (facet === 'year' && !YEAR.test(value)) continue;
    if (cards.some((card) => valuesOf(card, facet).includes(value))) selection[facet] = value;
  }
  return selection;
}

/**
 * Does the request carry ANY facet parameter (valid or not)? Such a response is private:
 * only the unfiltered URL is edge-cached (Tier A), so a crafted query cannot fill the
 * cache with variants.
 */
export function isFiltered(params: URLSearchParams): boolean {
  return FACETS.some((facet) => (params.get(facet) ?? '') !== '');
}

/** Every facet's values for one card — what a rendered card carries for the enhancement. */
export type FacetValues = Record<Facet, string[]>;

export function facetValues(card: PortfolioCard): FacetValues {
  return {
    service: valuesOf(card, 'service'),
    sector: valuesOf(card, 'sector'),
    client: valuesOf(card, 'client'),
    year: valuesOf(card, 'year'),
  };
}

/**
 * The AND across facets, over plain values — shared by the server (cards) and the browser
 * enhancement (the values each card element carries), so the two can never disagree about
 * which projects a filter shows.
 */
export function matchesValues(
  values: Partial<Record<Facet, readonly string[]>>,
  selection: FacetSelection,
): boolean {
  return FACETS.every((facet) => {
    const wanted = selection[facet];
    return wanted === undefined || (values[facet] ?? []).includes(wanted);
  });
}

export function matches(card: PortfolioCard, selection: FacetSelection): boolean {
  return matchesValues(facetValues(card), selection);
}

/** How many facets the selection sets (the active pills). */
export function activeFacets(selection: FacetSelection): Facet[] {
  return FACETS.filter((facet) => Boolean(selection[facet]));
}

/**
 * A selection read back from markup (the enhancement's `data-state`): only facet keys,
 * only string values, and only values the page actually offers (`known`). Anything else is
 * dropped — the attribute is server-written, but the browser re-validates rather than
 * trusting it, so no value can reach a URL or a label that the server did not render.
 */
export function sanitizeSelection(
  raw: unknown,
  known: Partial<Record<Facet, ReadonlySet<string>>>,
): FacetSelection {
  const out: FacetSelection = {};
  if (typeof raw !== 'object' || raw === null) return out;
  for (const facet of FACETS) {
    const value = (raw as Record<string, unknown>)[facet];
    if (typeof value === 'string' && known[facet]?.has(value)) out[facet] = value;
  }
  return out;
}

export function filterCards(
  cards: readonly PortfolioCard[],
  selection: FacetSelection,
): PortfolioCard[] {
  return cards.filter((card) => matches(card, selection));
}

export interface FacetOption {
  value: string;
  label: LocalizedText;
  count: number;
}

/**
 * The options a filter bar offers for a facet: only values that exist in `pool`, each
 * with its count over the pool (as the design does — counts do not shrink as other
 * filters apply). Years newest first; everything else in its catalogue order.
 */
export function facetOptions(cards: readonly PortfolioCard[], facet: Facet): FacetOption[] {
  const seen = new Map<string, FacetOption & { order: number }>();
  for (const card of cards) {
    const entries: { value: string; label: LocalizedText; order: number }[] =
      facet === 'service'
        ? card.services.map((s) => ({ value: s.slug, label: s.label, order: s.order }))
        : facet === 'sector'
          ? card.sector
            ? [{ value: card.sector.slug, label: card.sector.name, order: card.sector.order }]
            : []
          : facet === 'client'
            ? card.client
              ? [{ value: card.client.slug, label: card.client.name, order: card.client.order }]
              : []
            : card.year !== null
              ? [{ value: String(card.year), label: yearLabel(card.year), order: -card.year }]
              : [];
    for (const entry of entries) {
      const current = seen.get(entry.value);
      if (current) current.count += 1;
      else seen.set(entry.value, { ...entry, count: 1 });
    }
  }
  return [...seen.values()]
    .sort((a, b) => a.order - b.order || a.value.localeCompare(b.value))
    .map(({ value, label, count }) => ({ value, label, count }));
}

function yearLabel(year: number): LocalizedText {
  // The digits are localised at render (arabicIndic), like every number on the site.
  return { en: String(year), ar: String(year) };
}

/**
 * A query string for a selection — how links and the no-JS form address a filtered view.
 * Built from the selection's own (already validated) values, in FACETS order.
 */
export function facetQuery(selection: FacetSelection): string {
  const params = new URLSearchParams();
  for (const facet of FACETS) {
    const value = selection[facet];
    if (value) params.set(facet, value);
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

/**
 * The selection a facet tag links to: that value set — or, when it is already the active
 * one, that facet cleared (clicking the active tag turns it off, as in the design).
 */
export function toggleFacet(
  selection: FacetSelection,
  facet: Facet,
  value: string,
): FacetSelection {
  const next: FacetSelection = { ...selection };
  if (next[facet] === value) delete next[facet];
  else next[facet] = value;
  return next;
}

/** All projects: featured first, then catalogue order. */
export function catalogueOrder(cards: readonly PortfolioCard[]): PortfolioCard[] {
  return [...cards].sort(
    (a, b) => Number(b.isFeatured) - Number(a.isFeatured) || a.sortOrder - b.sortOrder,
  );
}

/** Our Work "latest": newest year first, then catalogue order (no year = oldest). */
export function latestOrder(cards: readonly PortfolioCard[]): PortfolioCard[] {
  return [...cards].sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || a.sortOrder - b.sortOrder);
}

/**
 * The project Our Work's banner shows: the pinned `projectSlug` when that project is
 * published, else the latest. null when there is none — or when it has no poster: the
 * poster is the banner (and the page's LCP image); a clip alone would open the page on a
 * blank dark block, and under reduced motion or Save-Data the loop never starts at all.
 * ONE decision, shared by WorkHero (what renders) and the route (which header it gets).
 */
export function bannerCard(
  cards: readonly PortfolioCard[],
  projectSlug?: unknown,
): PortfolioCard | null {
  const pinned =
    typeof projectSlug === 'string' ? cards.find((c) => c.slug === projectSlug) : undefined;
  const card = pinned ?? latestOrder(cards)[0];
  return card?.poster ? card : null;
}

/**
 * The case study's "next project": the editor's explicit choice when it is published, else
 * the project after it in catalogue order, wrapping round. null when it is the only one.
 */
export function nextProject(
  cards: readonly PortfolioCard[],
  current: { id: string; nextPortfolioId: string | null },
): PortfolioCard | null {
  if (current.nextPortfolioId) {
    const chosen = cards.find((c) => c.id === current.nextPortfolioId);
    if (chosen && chosen.id !== current.id) return chosen;
  }
  const ordered = catalogueOrder(cards);
  const index = ordered.findIndex((c) => c.id === current.id);
  if (ordered.length < 2) return null;
  return ordered[(index + 1) % ordered.length] ?? null;
}
