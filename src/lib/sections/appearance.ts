import {
  ANCHOR_MAX,
  ANCHOR_PATTERN,
  REVEAL_OPENING,
  anchorReserved,
  takesAnchor,
  takesBackground,
  takesReveal,
  takesSpacing,
} from '@schemas/sectionAppearance';
import type { SectionData } from './types';

// A section's appearance on the page (Admin v2 E9): its row's background, spacing, reveal and
// anchor become attributes on the section's OWN first element, the way the preview's marker is
// added (previewMarker.ts): `id`, `data-bg`, `data-space`, `data-reveal`. No wrapper (a page
// lays out exactly as before, no extra box between a section and the selectors that style it),
// no `style=` (CSP unchanged), no class merged into the component's own. global.css's E9 block
// reads the attributes. A section with nothing chosen gets nothing: its markup is byte for byte
// what it was (tests/render/sectionAppearance.spec.ts, and the render snapshots unchanged).
//
// Every rule the Worker and the database hold is held here again, so a row written around them
// (or one a later rule would refuse) never reaches the page wrong:
//   - a background, spacing or reveal the kind does not take is dropped;
//   - a reveal on one of the first REVEAL_OPENING sections the page shows is dropped (the
//     opening of a page always shows at once, CLAUDE.md §6);
//   - an anchor is dropped unless its shape is right, it is no id the site's code renders, the
//     kind takes one, and no other element of the page holds it: an earlier section's anchor,
//     or a discipline's slug in the route's data (the Services explorer's panels are ids named
//     by their discipline, which a discipline renamed after the anchor was saved could take);
//   - an attribute the element already has is never written twice (an `id` the component set
//     wins: applySectionAttrs).

/** The attributes of one section's first element, in the order they are written. */
export type SectionAttrs = Readonly<Record<string, string>>;

/** What an attribute value may be: the buckets' words and the anchors' shape, nothing to escape. */
const VALUE = /^[a-z][a-z0-9-]{0,63}$/;

/** The ids the route's data names on the page (the explorer's panels: the disciplines' slugs). */
function routeIds(shown: readonly SectionData[]): string[] {
  const out: string[] = [];
  for (const s of shown) {
    const list = s.data?.['disciplines'];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const slug = (item as { slug?: unknown } | null)?.slug;
      if (typeof slug === 'string') out.push(slug);
    }
  }
  return out;
}

/** Whether an anchor's shape is one the rules allow (the write's rule, restated). */
function anchorShaped(anchor: string): boolean {
  return anchor.length <= ANCHOR_MAX && ANCHOR_PATTERN.test(anchor) && !anchorReserved(anchor);
}

/**
 * The attributes each shown section's first element takes, by its place among the shown
 * sections (the list SectionRenderer renders), or undefined for a section that takes none.
 */
export function appearanceAttrs(shown: readonly SectionData[]): (SectionAttrs | undefined)[] {
  const taken = new Set(routeIds(shown));
  return shown.map((s, index) => {
    const look = s.appearance;
    if (!look) return undefined;
    const out: Record<string, string> = {};
    const variant = s.props?.['variant'];
    if (
      look.anchor !== undefined &&
      anchorShaped(look.anchor) &&
      takesAnchor(s.type, variant) &&
      !taken.has(look.anchor)
    ) {
      out['id'] = look.anchor;
      taken.add(look.anchor);
    }
    if (look.background !== undefined && takesBackground(s.type)) out['data-bg'] = look.background;
    if (look.spacing !== undefined && takesSpacing(s.type)) out['data-space'] = look.spacing;
    if (look.reveal !== undefined && takesReveal(s.type) && index >= REVEAL_OPENING) {
      out['data-reveal'] = look.reveal;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  });
}

/** The first element that is part of the section's layout (not a script, style or link). */
const FIRST_ELEMENT = /<(?!(?:script|style|link|template|meta)\b)([a-zA-Z][\w-]*)\b/;

/** Where the opening tag that starts at `from` ends (its `>`), quotes skipped; -1 if none. */
function tagEnd(html: string, from: number): number {
  let quote: string | null = null;
  for (let i = from; i < html.length; i++) {
    const c = html[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      return i;
    }
  }
  return -1;
}

/**
 * Writes a section's attributes onto the first element of its rendered HTML, right after the
 * tag name. An attribute the element already carries is left as the component wrote it (a
 * component's own `id` wins over an anchor), a value that is not a plain token is never
 * written, and markup with no element is returned as it is.
 */
export function applySectionAttrs(html: string, attrs: SectionAttrs): string {
  const m = FIRST_ELEMENT.exec(html);
  if (!m) return html;
  const at = m.index + m[0].length;
  const end = tagEnd(html, at);
  if (end === -1) return html;
  const tag = html.slice(at, end);
  const present = (name: string) => new RegExp(`(?:^|\\s)${name}(?:\\s*=|\\s|/|$)`).test(tag);
  const added = Object.entries(attrs)
    .filter(([name, value]) => /^(?:id|data-[a-z]+)$/.test(name) && VALUE.test(value))
    .filter(([name]) => !present(name))
    .map(([name, value]) => ` ${name}="${value}"`)
    .join('');
  return added === '' ? html : `${html.slice(0, at)}${added}${html.slice(at)}`;
}
