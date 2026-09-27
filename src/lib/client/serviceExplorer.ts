// The /services explorer's behaviour (ServiceExplorer.astro, Round 2).
//
// Every panel is server-rendered; this module only chooses which one shows. The division
// of labour is what keeps the page's CLS at 0:
//
//   First paint is CSS. `/services#events` (the home cards, the service pages' crumb, the
//   retired-slug 301s) opens the Events panel through `:target` before any script runs. A
//   script opening it after first paint would move everything below with no input to
//   excuse it — a layout shift that counts.
//
//   After that, this module owns the state. It adds `.is-live` to the explorer, which
//   switches the CSS from `:target` to the `.is-open` / `.is-active` classes — set here to
//   the panel `:target` already showed, so the switch changes nothing on screen. From then
//   on a card click, a tab (click or keys), prev/next or a `hashchange` opens a panel
//   INSTANTLY, inside the input's 500 ms window (hadRecentInput), and only the panel's body
//   fades and slides in (a compositor animation — the design's 0.9 s row expansion would
//   keep pushing the page after the window closed). The hash follows via replaceState,
//   which does not update `:target` — hence the class switch rather than :target forever.
//
//   Focus: a card or prev/next moves focus to the opened panel (role=tabpanel, tabindex 0)
//   and scrolls it into view (the panel's scroll-margin keeps the tabs above it on screen);
//   a tab keeps focus on itself (APG). The selected card gets `.on` (S2's selected state).
//   The panels join the Tab sequence only after `load`: a focusable fragment target is
//   FOCUSED by the browser's own fragment navigation, which on every deep link from the home
//   cards drew a focus ring round the whole panel for a mouse visitor. The fragment still
//   moves the sequential focus starting point there, so the next Tab lands in the panel.
//
//   Row hover / focus swaps the panel's media to that service's poster (a server-computed
//   URL in data-xp-poster, painted on an overlay <img> once decoded) and clip window
//   (clips.ts retargetClip); leaving the list restores the discipline's. Attributes and
//   textContent only — no inline style, no innerHTML.

import { focusablePanels, initTabs } from './tabs';
import { retargetClip, type ClipTarget } from './clips';

/** The panel a URL fragment names, or null (an unknown or empty hash opens nothing). */
export function panelFromHash(hash: string, slugs: readonly string[]): string | null {
  let slug = hash.startsWith('#') ? hash.slice(1) : hash;
  try {
    slug = decodeURIComponent(slug);
  } catch {
    return null;
  }
  return slugs.includes(slug) ? slug : null;
}

/** A row's clip window from its data attributes, or null when it has none. */
export function rowClip(data: DOMStringMap): ClipTarget | null {
  const src = data.xpClipSrc;
  if (!src) return null;
  const start = data.xpClipStart === undefined ? undefined : Number(data.xpClipStart);
  const end = data.xpClipEnd === undefined ? undefined : Number(data.xpClipEnd);
  return {
    src,
    start: Number.isFinite(start) ? start : undefined,
    end: Number.isFinite(end) ? end : undefined,
  };
}

interface Base {
  n: string;
  name: string;
  clip: ClipTarget | null;
}

function frameClip(frame: HTMLElement): ClipTarget | null {
  const d = frame.dataset;
  if (!d.clipSrc) return null;
  return {
    src: d.clipSrc,
    start: d.clipStart === undefined ? undefined : Number(d.clipStart),
    end: d.clipEnd === undefined ? undefined : Number(d.clipEnd),
  };
}

/** The row-hover media swap of one panel. */
function wireMedia(panel: HTMLElement): void {
  const media = panel.querySelector<HTMLElement>('[data-xp-media]');
  const frame = media?.querySelector<HTMLElement>('.mf');
  const list = panel.querySelector<HTMLElement>('[data-xp-list]');
  if (!media || !frame || !list) return;
  const capN = media.querySelector<HTMLElement>('[data-xp-cap-n]');
  const cap = media.querySelector<HTMLElement>('[data-xp-cap]');
  const base: Base = {
    n: capN?.textContent ?? '',
    name: cap?.textContent ?? '',
    clip: frameClip(frame),
  };
  let swap: HTMLImageElement | null = null;
  let wantedPoster = '';
  let shown: HTMLElement | null = null;

  const caption = (n: string, name: string) => {
    if (capN) capN.textContent = n;
    if (cap) cap.textContent = name;
  };

  const show = (row: HTMLElement) => {
    if (row === shown) return;
    shown = row;
    const d = row.dataset;
    caption(d.xpN ?? base.n, d.xpName ?? base.name);
    // Only a frame clips.ts wired (the discipline has a playable clip) can change window.
    const clip = rowClip(d) ?? base.clip;
    if (clip && base.clip) retargetClip(frame, clip);
    const url = d.xpPoster ?? '';
    wantedPoster = url;
    if (!url) {
      frame.classList.remove('is-swapped');
      return;
    }
    if (!swap) {
      swap = document.createElement('img');
      swap.className = 'svc-xp__swap';
      swap.alt = '';
      swap.decoding = 'async';
      // Above the poster, below a playing video (which clips.ts appends last).
      // (insertAdjacentElement / insertBefore: the Workers types' HTMLRewriter `Element`
      // shadows the DOM's ChildNode.after/prepend for tsc.)
      const picture = frame.querySelector('picture');
      if (picture) picture.insertAdjacentElement('afterend', swap);
      else frame.insertBefore(swap, frame.firstChild);
    }
    const img = swap;
    // The previous image stays painted until the new one is ready (an <img> keeps its
    // current request while the next one loads), so moving row to row never flashes.
    if (img.getAttribute('src') !== url) img.src = url;
    img
      .decode()
      .then(() => {
        if (wantedPoster === url) frame.classList.add('is-swapped');
      })
      .catch(() => {});
  };

  const restore = () => {
    shown = null;
    wantedPoster = '';
    frame.classList.remove('is-swapped');
    caption(base.n, base.name);
    if (base.clip) retargetClip(frame, base.clip);
  };

  list.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return;
    const row = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-xp-row]') : null;
    if (row) show(row);
  });
  list.addEventListener('pointerleave', (e) => {
    if (e.pointerType !== 'touch') restore();
  });
  list.addEventListener('focusin', (e) => {
    const row = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-xp-row]') : null;
    if (row) show(row);
  });
  list.addEventListener('focusout', (e) => {
    const next = e.relatedTarget;
    if (!(next instanceof Node) || !list.contains(next)) restore();
  });
}

export function initServiceExplorer(root: HTMLElement): void {
  if (root.classList.contains('is-live')) return;
  const tablist = root.querySelector<HTMLElement>('[data-xp-tabs]');
  const panels = [...root.querySelectorAll<HTMLElement>('[data-xp-panel]')];
  const tabs = [...root.querySelectorAll<HTMLElement>('[data-xp-tab]')];
  if (!tablist || panels.length === 0 || tabs.length !== panels.length) return;
  const slugs = panels.map((p) => p.dataset.xpPanel ?? '');
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const cards = () => [...document.querySelectorAll<HTMLElement>('.disc-card[data-disc]')];
  let current: string | null = null;

  const widget = initTabs({
    tablist,
    tabs,
    panels,
    label: tablist.dataset.xpLabel ?? '',
    onSelect: (i) => open(slugs[i] ?? '', { focus: null, scroll: false }),
  });

  /** Keeps the selected pill in view in its (horizontally scrolling, on phones) row. */
  const revealTab = (tab: HTMLElement) => {
    const list = tablist.getBoundingClientRect();
    const box = tab.getBoundingClientRect();
    if (box.left < list.left) tablist.scrollBy({ left: box.left - list.left - 16 });
    else if (box.right > list.right) tablist.scrollBy({ left: box.right - list.right + 16 });
  };

  function open(
    slug: string,
    how: { focus: 'panel' | null; scroll: boolean; animate?: boolean },
  ): void {
    const i = slugs.indexOf(slug);
    const panel = panels[i];
    if (!panel) return;
    const changed = current !== slug;
    current = slug;
    root.classList.add('is-open');
    for (const p of panels) {
      const on = p === panel;
      p.classList.toggle('is-active', on);
      if (!on) p.classList.remove('is-entering');
    }
    // A panel that was hidden restarts its entrance as it is displayed (the animation is
    // on its inner grid, so the panel box — what scrollIntoView aims at — never moves).
    if (changed && how.animate !== false && !reduced()) panel.classList.add('is-entering');
    widget.select(i);
    for (const card of cards()) card.classList.toggle('on', card.dataset.disc === slug);
    document.getElementById('categories')?.classList.add('is-picked');
    const tab = tabs[i];
    if (tab) revealTab(tab);
    if (location.hash !== `#${slug}`) {
      history.replaceState(history.state, '', `${location.pathname}${location.search}#${slug}`);
    }
    if (how.focus === 'panel') {
      panel.tabIndex = 0;
      panel.focus({ preventScroll: true });
    }
    if (how.scroll) {
      panel.scrollIntoView({ block: 'start', behavior: reduced() ? 'auto' : 'smooth' });
    }
  }

  for (const panel of panels) {
    panel.addEventListener('animationend', (e) => {
      if (e.target instanceof Element && e.target.classList.contains('svc-xp__grid')) {
        panel.classList.remove('is-entering');
      }
    });
    wireMedia(panel);
  }

  if (document.readyState === 'complete') focusablePanels(panels);
  else
    addEventListener('load', () => requestAnimationFrame(() => focusablePanels(panels)), {
      once: true,
    });

  // Hand-over: what `:target` showed (if anything) becomes the state, with no change on
  // screen — no animation, no scroll (the browser already scrolled to the fragment).
  root.classList.add('is-live');
  const initial = panelFromHash(location.hash, slugs);
  if (initial) open(initial, { focus: null, scroll: false, animate: false });

  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return;
    }
    const target = e.target instanceof Element ? e.target : null;
    const card = target?.closest<HTMLElement>('.disc-card[data-disc]');
    const go = target?.closest<HTMLElement>('[data-xp-go]');
    const slug = card?.dataset.disc ?? go?.dataset.xpGo;
    if (!slug || !slugs.includes(slug)) return;
    // Only an in-page card (page mode links `#slug`) — never a link to another page.
    const href = (card ?? go)?.getAttribute('href') ?? '';
    if (!href.startsWith('#')) return;
    e.preventDefault();
    open(slug, { focus: 'panel', scroll: true });
  });

  addEventListener('hashchange', () => {
    const slug = panelFromHash(location.hash, slugs);
    if (slug) open(slug, { focus: null, scroll: true });
  });
}
