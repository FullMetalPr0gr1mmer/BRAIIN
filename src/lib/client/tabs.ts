// Tabs, per the WAI-ARIA Authoring Practices "Tabs" pattern (automatic activation) — the
// /services explorer's discipline pills (ServiceExplorer.astro).
//
// The markup is progressive: without JS every tab is a plain `<a href="#slug">` and every
// panel a plain block (CSS `:target` shows the addressed one). This module turns them into
// a real tab widget — and only then, so no role ever promises a behaviour that is not there:
//
//   tablist   role=tablist + aria-label (from `label`)
//   tab       role=tab, aria-controls → its panel, aria-selected, roving tabindex (only the
//             selected tab is in the Tab sequence; 0 on the first while none is selected)
//   panel     role=tabpanel, aria-labelledby → its tab; tabindex=0 (APG: a panel whose
//             first content is not focusable joins the Tab sequence) through
//             focusablePanels(), which the caller runs when it chooses — see the explorer
//
// Keys on the tablist: ArrowLeft / ArrowRight move to the previous / next tab and select it
// — mirrored in RTL, where "next" is to the LEFT — wrapping at both ends; Home / End go to
// the first / last; Enter and Space select (Enter already clicks a link). No region-wide
// aria-live: the selected tab's own announcement (name + "selected") is the feedback.
//
// Selection itself is the caller's (`onSelect`): the explorer decides what "open" means
// (panels, hash, cards) and calls `select()` back to update the ARIA state.

export type TabMove = 'prev' | 'next' | 'first' | 'last';

/** What a key does on a horizontal tablist, or null when it is not a tabs key. */
export function tabKeyMove(key: string, rtl: boolean): TabMove | null {
  switch (key) {
    case 'ArrowRight':
      return rtl ? 'prev' : 'next';
    case 'ArrowLeft':
      return rtl ? 'next' : 'prev';
    case 'Home':
      return 'first';
    case 'End':
      return 'last';
    default:
      return null;
  }
}

/** The tab index a move lands on, wrapping at both ends. */
export function tabIndexAfter(current: number, move: TabMove, count: number): number {
  if (count <= 0) return 0;
  switch (move) {
    case 'first':
      return 0;
    case 'last':
      return count - 1;
    case 'next':
      return (current + 1) % count;
    case 'prev':
      return (current - 1 + count) % count;
  }
}

/** The tabindex each tab carries: 0 on the selected one (else the first), -1 on the rest. */
export function rovingTabIndexes(count: number, selected: number | null): number[] {
  const active = selected !== null && selected >= 0 && selected < count ? selected : 0;
  return Array.from({ length: count }, (_, i) => (i === active ? 0 : -1));
}

export interface TabsOptions {
  tablist: HTMLElement;
  tabs: readonly HTMLElement[];
  panels: readonly HTMLElement[];
  /** The tablist's accessible name. */
  label: string;
  /** A tab was chosen (click, Enter/Space, or an arrow/Home/End move). */
  onSelect: (index: number, source: 'pointer' | 'key') => void;
}

export interface Tabs {
  /** Reflects the selection in the ARIA state and the roving tabindex (null: none). */
  select(index: number | null): void;
}

/** Puts every panel in the Tab sequence (tabindex=0). */
export function focusablePanels(panels: readonly HTMLElement[]): void {
  for (const panel of panels) panel.tabIndex = 0;
}

export function initTabs({ tablist, tabs, panels, label, onSelect }: TabsOptions): Tabs {
  tablist.setAttribute('role', 'tablist');
  tablist.setAttribute('aria-label', label);
  tabs.forEach((tab, i) => {
    const panel = panels[i];
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', 'false');
    if (panel) {
      tab.setAttribute('aria-controls', panel.id);
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', tab.id);
    }
  });

  const select = (index: number | null) => {
    const indexes = rovingTabIndexes(tabs.length, index);
    tabs.forEach((tab, i) => {
      tab.setAttribute('aria-selected', String(i === index));
      tab.tabIndex = indexes[i] ?? -1;
    });
  };
  select(null);

  const rtl = () => getComputedStyle(tablist).direction === 'rtl';

  tablist.addEventListener('click', (e) => {
    const tab = e.target instanceof Element ? e.target.closest('[role="tab"]') : null;
    const i = tab ? tabs.indexOf(tab as HTMLElement) : -1;
    if (i === -1) return;
    e.preventDefault(); // a tab is still an <a href="#slug">: the caller owns the hash
    onSelect(i, 'pointer');
  });

  tablist.addEventListener('keydown', (e) => {
    const i = e.target instanceof HTMLElement ? tabs.indexOf(e.target) : -1;
    if (i === -1 || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault(); // Space would scroll the page; on a tab it selects
      onSelect(i, 'key');
      return;
    }
    const move = tabKeyMove(e.key, rtl());
    if (!move) return;
    e.preventDefault();
    // From the FOCUSED tab (with automatic activation it is also the selected one).
    const to = tabIndexAfter(i, move, tabs.length);
    tabs[to]?.focus();
    onSelect(to, 'key');
  });

  return { select };
}
