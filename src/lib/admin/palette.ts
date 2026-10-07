import type { IconName } from './icons';

// The command palette's model (Admin v2 F3), kept free of React and the DOM so it is
// tested directly: what the palette lists for a query, in which groups, and where the
// keyboard moves. CommandPalette.tsx renders it.

export interface PaletteItem {
  /** Unique within the list: the option's DOM id derives from it. */
  key: string;
  label: string;
  href: string;
  icon: IconName;
  /** A second line: an area for a screen, a slug or path for a record. */
  detail?: string | undefined;
}

export interface PaletteGroup {
  title: string;
  items: PaletteItem[];
}

/** The fewest characters the server search is asked for (its own floor is the same). */
export const MIN_REMOTE_QUERY = 2;

/** Lower-cased, accents and repeated spaces folded: what matching compares. */
export function normalize(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True when every word of the query begins a word of the label, in order or not:
 * "case st" finds "Case studies", "new pro" finds "New project". Prefix-per-word keeps a
 * short query from matching the middle of unrelated words ("art" does not find "Start").
 */
export function matches(label: string, query: string): boolean {
  const q = normalize(query);
  if (!q) return true;
  const words = normalize(label).split(/[\s/&·-]+/);
  return q.split(' ').every((part) => words.some((word) => word.startsWith(part)));
}

/** The local groups (screens, actions) filtered by the query; empty groups dropped. */
export function filterGroups(groups: readonly PaletteGroup[], query: string): PaletteGroup[] {
  return groups
    .map((group) => ({
      title: group.title,
      items: group.items.filter((i) => matches(i.label, query)),
    }))
    .filter((group) => group.items.length > 0);
}

/** Every item in display order: what the arrow keys walk. */
export function flatten(groups: readonly PaletteGroup[]): PaletteItem[] {
  return groups.flatMap((group) => group.items);
}

/** The next active index for an arrow key, wrapping at both ends; -1 when nothing is listed. */
export function move(current: number, count: number, direction: 1 | -1): number {
  if (count === 0) return -1;
  if (current < 0) return direction === 1 ? 0 : count - 1;
  return (current + direction + count) % count;
}

/** The server's search result, as GET /api/admin/search returns it. */
export interface RemoteGroup {
  group: string;
  hits: { href: string; label: string; detail: string | null }[];
}

/** Server hits as palette groups: records get the file icon and their slug or path. */
export function remoteGroups(groups: readonly RemoteGroup[]): PaletteGroup[] {
  return groups.map((group) => ({
    title: group.group,
    items: group.hits.map((hit) => ({
      key: `r:${hit.href}`,
      label: hit.label,
      href: hit.href,
      icon: 'pages' as const,
      detail: hit.detail ?? undefined,
    })),
  }));
}

/** The palette's last option: the full, no-JS results page for the same query. */
export function seeAll(query: string): PaletteItem {
  return {
    key: 'see-all',
    label: `See all results for “${query.trim()}”`,
    href: `/admin/search?q=${encodeURIComponent(query.trim())}`,
    icon: 'search',
  };
}
