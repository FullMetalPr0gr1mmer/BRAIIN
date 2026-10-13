// The component kit screen's made-up data (Admin v2 F4b, /admin/kit): shared by the page,
// its island and tests/admin/kit.e2e.ts, so the browser test asserts the same names the
// screen draws. Nothing here is real content and nothing is saved.

/** The island's tabs, and the query parameter they keep in step (`?tab=`). */
export const KIT_TAB_PARAM = 'tab';
export const KIT_TAB_IDS = ['content', 'seo', 'media'] as const;
export type KitTab = (typeof KIT_TAB_IDS)[number];

/** The sortable list's sections, in their first order. */
export const KIT_SECTIONS = [
  { id: 'hero', label: 'Hero' },
  { id: 'services', label: 'Services' },
  { id: 'work', label: 'Selected work' },
  { id: 'clients', label: 'Clients' },
  { id: 'contact', label: 'Say hello' },
] as const;

/** The two-column board: widgets in a left and a right column. */
export const KIT_COLUMNS = {
  left: [
    { id: 'visits', label: 'Visits' },
    { id: 'inquiries', label: 'New inquiries' },
  ],
  right: [
    { id: 'health', label: 'Site health' },
    { id: 'drafts', label: 'Drafts waiting' },
  ],
} as const;

export interface KitRow {
  id: string;
  title: string;
  status: 'draft' | 'scheduled' | 'published' | 'archived';
  views: number;
}

const STATUSES: readonly KitRow['status'][] = ['published', 'draft', 'scheduled', 'archived'];

/** The data table's rows: 60 made-up entries, read a page at a time like a server list. */
export const KIT_ROWS: readonly KitRow[] = Array.from({ length: 60 }, (_, i) => ({
  id: `kit-${i + 1}`,
  title: `Sample entry ${i + 1}`,
  status: STATUSES[i % STATUSES.length] ?? 'draft',
  views: (i + 1) * 137,
}));
