// The Header screen's Menu items card (Admin v2 E5), pure so it is unit-tested
// (tests/lib/headerScreen.spec.ts): the header menu's top-level links in the site's order, and
// the writes that move the key star. The writes themselves are the navigation API's
// (`/api/admin/navigation`, nav.edit), one versioned PATCH per row.

type Row = Readonly<Record<string, unknown>>;

export interface MenuRow {
  id: string;
  label: string;
  href: string;
  visible: boolean;
  isKey: boolean;
  sortOrder: number;
  version: number;
  /** How many links sit under it (shown, edited on the Menus screen). */
  children: number;
}

const text = (value: unknown): string => {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object') {
    const v = value as Row;
    const en = typeof v['en'] === 'string' ? v['en'].trim() : '';
    const ar = typeof v['ar'] === 'string' ? v['ar'].trim() : '';
    return en || ar;
  }
  return '';
};

/** The header menu's rows (an API list answer's `rows`) → its top-level links, in order. */
export function menuRows(rows: readonly Row[]): MenuRow[] {
  const header = rows.filter((row) => row['location'] === 'header');
  const children = new Map<string, number>();
  for (const row of header) {
    const parent = row['parent_id'];
    if (typeof parent === 'string') children.set(parent, (children.get(parent) ?? 0) + 1);
  }
  return header
    .filter((row) => typeof row['id'] === 'string' && !row['parent_id'])
    .map((row) => {
      const id = row['id'] as string;
      return {
        id,
        label: text(row['label']) || 'Untitled link',
        href: typeof row['href'] === 'string' ? row['href'] : '',
        visible: row['visible'] !== false,
        isKey: row['is_key'] === true,
        sortOrder: Number(row['sort_order'] ?? 0),
        version: Number(row['version'] ?? 0),
        children: children.get(id) ?? 0,
      };
    })
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
}

export interface KeyChange {
  id: string;
  version: number;
  isKey: boolean;
}

/**
 * The PATCHes a press of a row's star sends, in order: one key link per menu (0019's unique
 * index), so the old key is cleared before the new one is set; a press on the key itself
 * clears it.
 */
export function keyChanges(rows: readonly MenuRow[], id: string): KeyChange[] {
  const row = rows.find((r) => r.id === id);
  if (!row) return [];
  if (row.isKey) return [{ id, version: row.version, isKey: false }];
  const current = rows.find((r) => r.isKey);
  return [
    ...(current ? [{ id: current.id, version: current.version, isKey: false }] : []),
    { id, version: row.version, isKey: true },
  ];
}

/** The order after moving one row up (-1) or down (1), as ids; unchanged at an end. */
export function movedOrder(rows: readonly MenuRow[], id: string, step: -1 | 1): string[] {
  const ids = rows.map((r) => r.id);
  const at = ids.indexOf(id);
  const to = at + step;
  if (at < 0 || to < 0 || to >= ids.length) return ids;
  [ids[at], ids[to]] = [ids[to]!, ids[at]!];
  return ids;
}
