// In-page filtering for the project catalogues (UI v2 — Our Work's featured grid and All
// projects): src/components/portfolio/FilterBar.astro + ProjectGrid / ProjectCatalog.
//
// The server already renders a complete, working catalogue: every control is a link or a
// GET form, the grid is filtered, and a filtered URL is a real page. This only makes the
// same controls apply IN PLACE:
//   * the selection comes from the server's `data-state` (re-validated against the values
//     the page actually carries) — never from `location.search`, so nothing a visitor
//     puts in the query can reach the page through here (the mockup's reflected
//     `?year=<img onerror>` XSS came from exactly that);
//   * nothing is built from strings: cards and pills are toggled with `hidden`, labels
//     are set with textContent, links get new hrefs built from known values only;
//   * the URL follows with history.replaceState (no history entries — Back leaves the
//     page, as in the design);
//   * focus stays on the control that was used; if that control disappears (a removed
//     pill, the empty state's Clear), it moves to the result count.
// Pure helpers are exported for tests/lib/catalogFilter.spec.ts.

import type { Locale } from '@schemas/primitives';
import {
  FACETS,
  facetQuery,
  matchesValues,
  sanitizeSelection,
  toggleFacet,
  type Facet,
  type FacetSelection,
  type FacetValues,
} from '@/lib/portfolio/catalog';
import { featuredCount, projectCount, removeLabel, seeAllLabel } from '@/lib/portfolio/filterText';

type Values = Partial<FacetValues>;

export const isFacet = (v: string | undefined): v is Facet =>
  v !== undefined && (FACETS as readonly string[]).includes(v);

function parseJson(text: string | undefined): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** A card's facet values from its `data-facets` — strings only, facet keys only. */
export function readValues(raw: unknown): Values {
  const out: Values = {};
  if (typeof raw !== 'object' || raw === null) return out;
  for (const facet of FACETS) {
    const list = (raw as Record<string, unknown>)[facet];
    if (Array.isArray(list)) out[facet] = list.filter((v): v is string => typeof v === 'string');
  }
  return out;
}

/**
 * The selection after a control is activated. `all` clears everything; an empty value
 * clears that facet (a pill, "All services"); a value toggles (a chip or a card tag —
 * activating the active one turns it off, as in the design).
 */
export function nextSelection(
  selection: FacetSelection,
  facet: Facet | 'all',
  value: string,
): FacetSelection {
  if (facet === 'all') return {};
  if (value === '') {
    const next = { ...selection };
    delete next[facet];
    return next;
  }
  return toggleFacet(selection, facet, value);
}

/** A select sets its facet (or clears it with the "All …" option) — it never toggles. */
export function withFacet(selection: FacetSelection, facet: Facet, value: string): FacetSelection {
  const next = { ...selection };
  if (value) next[facet] = value;
  else delete next[facet];
  return next;
}

/** The URL of a selection on this page. */
export function hrefFor(base: string, selection: FacetSelection, fragment = ''): string {
  return `${base}${facetQuery(selection)}${fragment}`;
}

function enhance(root: HTMLElement): void {
  if (root.dataset.enhanced) return;
  root.dataset.enhanced = '1';

  const locale: Locale = root.dataset.locale === 'ar' ? 'ar' : 'en';
  const base = root.dataset.base ?? location.pathname;
  const fragment = root.dataset.fragment ?? '';
  const featured = root.dataset.catalog === 'featured';

  const cards = [...root.querySelectorAll<HTMLElement>('[data-card]')].map((el) => ({
    el,
    values: readValues(parseJson(el.dataset.facets)),
  }));
  const known: Partial<Record<Facet, Set<string>>> = {};
  for (const facet of FACETS) {
    known[facet] = new Set(cards.flatMap((c) => c.values[facet] ?? []));
  }
  let state = sanitizeSelection(parseJson(root.dataset.state), known);

  const bar = root.querySelector<HTMLElement>('[data-filter-bar]');
  const labels = (parseJson(bar?.dataset.labels) ?? {}) as Partial<
    Record<Facet, Record<string, unknown>>
  >;
  const labelOf = (facet: Facet, value: string): string => {
    const text = labels[facet]?.[value];
    return typeof text === 'string' ? text : value;
  };
  const count =
    root.querySelector<HTMLElement>('[data-count]') ??
    (root.dataset.countId ? document.getElementById(root.dataset.countId) : null);
  const empty = root.querySelector<HTMLElement>('[data-empty]');
  const active = root.querySelector<HTMLElement>('[data-active]');
  const seeAll = root.querySelector<HTMLAnchorElement>('a[data-see-all]');
  const seeAllText = seeAll?.querySelector<HTMLElement>('[data-see-all-label]') ?? null;
  const seeAllBase = seeAll ? new URL(seeAll.href).pathname : '';
  const index = Array.isArray(parseJson(seeAll?.dataset.index))
    ? (parseJson(seeAll?.dataset.index) as unknown[]).map(readValues)
    : [];

  // The selects apply on change; the Apply button is the no-JS path only.
  for (const button of root.querySelectorAll<HTMLElement>('[data-apply]')) button.hidden = true;

  const render = () => {
    let shown = 0;
    for (const card of cards) {
      const visible = matchesValues(card.values, state);
      card.el.hidden = !visible;
      if (visible) shown += 1;
    }
    const any = FACETS.some((f) => state[f]);

    for (const link of root.querySelectorAll<HTMLAnchorElement>('a[data-f]')) {
      const facet = link.dataset.f;
      const value = link.dataset.v ?? '';
      if (facet === 'all') {
        link.href = hrefFor(base, {}, fragment);
        if (link.hasAttribute('data-clear')) link.hidden = !any;
        continue;
      }
      if (!isFacet(facet)) continue;
      if (link.hasAttribute('data-pill')) {
        const current = state[facet];
        link.hidden = !current;
        link.href = hrefFor(base, nextSelection(state, facet, ''), fragment);
        const text = link.querySelector<HTMLElement>('[data-pill-value]');
        if (current) {
          const label = labelOf(facet, current);
          if (text) text.textContent = label;
          link.setAttribute('aria-label', removeLabel(label, locale));
        } else {
          link.removeAttribute('aria-label');
        }
        continue;
      }
      // A chip or a card tag; the empty value is "All services".
      const on = value === '' ? !state[facet] : state[facet] === value;
      link.classList.toggle('is-on', on);
      if (on) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
      link.href = hrefFor(base, nextSelection(state, facet, on ? '' : value), fragment);
    }

    // By tag name (the DOM lib types `select` itself; a generic on the selector trips a
    // lib quirk around HTMLSelectElement.remove()).
    for (const select of root.querySelectorAll('select')) {
      const facet = select.dataset.f;
      if (!isFacet(facet)) continue;
      select.value = state[facet] ?? '';
      select.closest('.fb__sel')?.classList.toggle('is-on', Boolean(state[facet]));
    }

    if (active) active.hidden = !any;
    if (empty) empty.hidden = shown > 0;
    if (count) {
      count.textContent = featured
        ? featuredCount(shown, cards.length, locale)
        : projectCount(shown, locale);
    }
    if (seeAll) {
      seeAll.href = `${seeAllBase}${facetQuery(state)}`;
      if (seeAllText) {
        const matching = any ? index.filter((v) => matchesValues(v, state)).length : null;
        seeAllText.textContent = seeAllLabel(matching, locale);
      }
    }
  };

  const commit = (next: FacetSelection) => {
    state = next;
    render();
    history.replaceState(history.state, '', `${base}${facetQuery(state)}${location.hash}`);
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && root.contains(focused) && focused.closest('[hidden]')) {
      count?.focus();
    }
  };

  // A card tag used far from the bar brings the bar back into view (the design's
  // behaviour), so the visitor sees what changed.
  const revealBar = () => {
    if (!bar) return;
    const top = bar.getBoundingClientRect().top;
    if (top >= 0 && top <= innerHeight * 0.6) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    bar.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
  };

  root.addEventListener('click', (event) => {
    // A modified click (new tab, new window) keeps the link's own behaviour.
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = (event.target as Element | null)?.closest<HTMLAnchorElement>('a[data-f]');
    if (!link || !root.contains(link)) return;
    const facet = link.dataset.f;
    const value = link.dataset.v ?? '';
    if (facet !== 'all' && !isFacet(facet)) return;
    if (facet !== 'all' && value !== '' && !known[facet]?.has(value)) return;
    event.preventDefault();
    commit(nextSelection(state, facet, value));
    if (link.classList.contains('ftag')) revealBar();
  });

  root.addEventListener('change', (event) => {
    const select = event.target;
    if (!(select instanceof HTMLSelectElement)) return;
    const facet = select.dataset.f;
    if (!isFacet(facet)) return;
    const value = select.value;
    if (value !== '' && !known[facet]?.has(value)) return;
    commit(withFacet(state, facet, value));
  });

  root
    .querySelector('form[data-filter-form]')
    ?.addEventListener('submit', (event) => event.preventDefault());
}

/** Enhances every catalogue on the page (idempotent). */
export function initCatalogFilters(): void {
  for (const root of document.querySelectorAll<HTMLElement>('[data-catalog]')) enhance(root);
}
