import { readDraft } from '@/lib/admin/entitySave';
import { FOOTER_COLUMNS_MAX } from '@schemas/admin';
import type { PendingRef } from '../header/menu';

// The Footer screen's Columns card (Admin v2 E6), pure so it is unit-tested
// (tests/lib/footerScreen.spec.ts): the footer's rows of the navigation API's list as columns
// (heading rows, 0122) with the links under each, and the footer links outside any column.
// The writes are the navigation API's (`/api/admin/navigation`, nav.edit): a create for a new
// column, one versioned PATCH per row for its column or its eye, the reorder route for an
// order. The header's card (../header/menu.ts) supplies the shared pieces: the paged read, the
// release-mode row write and what a change says.

type Row = Readonly<Record<string, unknown>>;

export { FOOTER_COLUMNS_MAX };

const pendingOf = (row: Row): PendingRef | null => {
  const draft = readDraft(row);
  return draft ? { id: draft.id, version: draft.version } : null;
};

const text = (value: unknown, lang: 'en' | 'ar'): string => {
  if (value && typeof value === 'object') {
    const v = (value as Row)[lang];
    return typeof v === 'string' ? v.trim() : '';
  }
  return '';
};

/** One footer row as the card draws it: a column or a link. */
export interface FooterItem {
  id: string;
  /** The English title or label (the Arabic one when there is no English). */
  label: string;
  /** Both titles, as saved. */
  title: { en: string; ar: string };
  href: string;
  visible: boolean;
  sortOrder: number;
  version: number;
  /** Its pending change (releases on), named by every write to it. */
  pending: PendingRef | null;
  /** For a link: the column it sits in (a heading's id), else null. */
  column: string | null;
  /** For a link: how many sub-links sit under it (edited on the Menus screen). */
  children: number;
}

export interface FooterColumn extends FooterItem {
  links: FooterItem[];
}

/** The footer as the card draws it. */
export interface FooterModel {
  columns: FooterColumn[];
  /** The top-level footer links outside any column, in order. */
  loose: FooterItem[];
}

const bySort = (a: FooterItem, b: FooterItem) =>
  a.sortOrder - b.sortOrder || a.id.localeCompare(b.id);

/** The navigation list's rows (any location) → the footer's columns and loose links. */
export function footerModel(rows: readonly Row[]): FooterModel {
  const footer = rows.filter((r) => r['location'] === 'footer' && typeof r['id'] === 'string');
  const headingIds = new Set(
    footer.filter((r) => r['is_heading'] === true && !r['parent_id']).map((r) => r['id'] as string),
  );
  const children = new Map<string, number>();
  for (const r of footer) {
    const parent = r['parent_id'];
    if (typeof parent === 'string' && !headingIds.has(parent)) {
      children.set(parent, (children.get(parent) ?? 0) + 1);
    }
  }
  const item = (r: Row): FooterItem => {
    const id = r['id'] as string;
    const title = { en: text(r['label'], 'en'), ar: text(r['label'], 'ar') };
    const parent = typeof r['parent_id'] === 'string' ? (r['parent_id'] as string) : null;
    return {
      id,
      label:
        title.en || title.ar || (r['is_heading'] === true ? 'Untitled column' : 'Untitled link'),
      title,
      href: typeof r['href'] === 'string' ? r['href'] : '',
      visible: r['visible'] !== false,
      sortOrder: Number(r['sort_order'] ?? 0),
      version: Number(r['version'] ?? 0),
      pending: pendingOf(r),
      column: parent && headingIds.has(parent) ? parent : null,
      children: children.get(id) ?? 0,
    };
  };
  const columns: FooterColumn[] = footer
    .filter((r) => headingIds.has(r['id'] as string))
    .map((r) => ({ ...item(r), links: [] as FooterItem[] }))
    .sort(bySort);
  const byId = new Map(columns.map((c) => [c.id, c]));
  const loose: FooterItem[] = [];
  for (const r of footer) {
    if (r['is_heading'] === true) continue;
    const it = item(r);
    if (it.column) byId.get(it.column)?.links.push(it);
    else if (!r['parent_id']) loose.push(it);
  }
  for (const c of columns) c.links.sort(bySort);
  loose.sort(bySort);
  return { columns, loose };
}

/** True while the footer can take another column (the database refuses a fifth, 0122). */
export function canAddColumn(model: FooterModel): boolean {
  return model.columns.length < FOOTER_COLUMNS_MAX;
}

/** The next free place at the end of a list (orderChanges numbers lists in tens). */
export function nextSortOrder(items: readonly { sortOrder: number }[]): number {
  return items.reduce((max, i) => Math.max(max, i.sortOrder), 0) + 10;
}

/** A new column's create body: a footer heading with no link, shown, at the end. */
export function newColumnBody(
  title: { en: string; ar: string },
  model: FooterModel,
): Record<string, unknown> {
  return {
    location: 'footer',
    label: { en: title.en.trim(), ar: title.ar.trim() },
    isHeading: true,
    visible: true,
    sortOrder: nextSortOrder([...model.columns, ...model.loose]),
  };
}

/** What a title a person typed lacks, or null when both languages are there. */
export function titleProblem(title: { en: string; ar: string }): string | null {
  const en = title.en.trim();
  const ar = title.ar.trim();
  if (!en && !ar) return 'Write the column title in English and Arabic.';
  if (!en) return 'Write the English title too.';
  if (!ar) return 'Write the Arabic title too.';
  if (en.length > 200 || ar.length > 200) return 'Keep each title under 200 characters.';
  return null;
}

/**
 * The PATCH values that move a link into a column (its heading's id), or out of every column
 * (null), at the end of where it lands; null when it is already there.
 */
export function columnMove(
  model: FooterModel,
  link: FooterItem,
  column: string | null,
): { parentId: string | null; sortOrder: number } | null {
  if (link.column === column) return null;
  const target = column === null ? model.loose : model.columns.find((c) => c.id === column)?.links;
  if (!target) return null;
  return { parentId: column, sortOrder: nextSortOrder(target) };
}

/** The ids after moving one up (-1) or down (1) in its group; unchanged at an end. */
export function movedIds(ids: readonly string[], id: string, step: -1 | 1): string[] {
  const next = [...ids];
  const at = next.indexOf(id);
  const to = at + step;
  if (at < 0 || to < 0 || to >= next.length) return next;
  [next[at], next[to]] = [next[to]!, next[at]!];
  return next;
}
