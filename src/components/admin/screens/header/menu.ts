import { readDraft } from '@/lib/admin/entitySave';

// The Header screen's Menu items card (Admin v2 E5), pure so it is unit-tested
// (tests/lib/headerOptions.spec.ts): the header menu's top-level links in the site's order, and
// the writes that move the key star. The writes themselves are the navigation API's
// (`/api/admin/navigation`, nav.edit), one versioned PATCH per row.

type Row = Readonly<Record<string, unknown>>;

/** A row's pending change (releases on), which a write to it names. */
export interface PendingRef {
  id: string;
  version: number;
}

const pendingOf = (row: Row): PendingRef | null => {
  const draft = readDraft(row);
  return draft ? { id: draft.id, version: draft.version } : null;
};

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
  /** Its pending change (releases on), named by every write to it. */
  pending: PendingRef | null;
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
        pending: pendingOf(row),
      };
    })
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
}

/** The link that holds the menu's one key: a top-level link or a sub-link. */
export interface KeyHolder {
  id: string;
  label: string;
  version: number;
  pending: PendingRef | null;
  /** A sub-link: not in the card's list, so the card names it. */
  sub: boolean;
}

/**
 * The header menu's key link among ALL its rows (an API list answer's `rows`). 0019's unique
 * index (`navigation_one_key_per_location`) holds one key per menu, sub-links included, so a
 * star pressed in the card must clear a sub-link's key too, or the database refuses the new
 * one (23505).
 */
export function menuKey(rows: readonly Row[]): KeyHolder | null {
  const row = rows.find(
    (r) => r['location'] === 'header' && r['is_key'] === true && typeof r['id'] === 'string',
  );
  if (!row) return null;
  return {
    id: row['id'] as string,
    label: text(row['label']) || 'Untitled link',
    version: Number(row['version'] ?? 0),
    pending: pendingOf(row),
    sub: typeof row['parent_id'] === 'string',
  };
}

export interface KeyChange {
  id: string;
  version: number;
  isKey: boolean;
  pending: PendingRef | null;
}

/**
 * The PATCHes a press of a row's star sends, in order: one key link per menu (0019's unique
 * index), so the old key, wherever it sits (`key`, from menuKey), is cleared before the new one
 * is set; a press on the key itself clears it.
 */
export function keyChanges(
  rows: readonly MenuRow[],
  id: string,
  key: KeyHolder | null,
): KeyChange[] {
  const row = rows.find((r) => r.id === id);
  if (!row) return [];
  const own = { id, version: row.version, pending: row.pending };
  if (key?.id === id) return [{ ...own, isKey: false }];
  return [
    ...(key
      ? [
          {
            id: key.id,
            version: key.version,
            pending: key.pending,
            isKey: false,
          },
        ]
      : []),
    { ...own, isKey: true },
  ];
}

/** One PATCH to a row: its body, and whether it carries R12's marker (stagedBody). */
export interface RowWrite {
  body: Record<string, unknown>;
  mark: boolean;
}

/**
 * A PATCH to one row, as the page editor's column sends it (R12b): with releases on, the row's
 * pending change when it has one, else R12's marker; with releases off, the values and the
 * version alone. The caller sends `stagedBody(write.body, write.mark)`.
 */
export function rowWrite(
  values: Readonly<Record<string, unknown>>,
  target: { version: number; pending: PendingRef | null },
  staged: boolean,
): RowWrite {
  const ref =
    staged && target.pending
      ? {
          draftId: target.pending.id,
          draftVersion: target.pending.version,
        }
      : {};
  return {
    body: { ...values, version: target.version, ...ref },
    mark: staged && !target.pending,
  };
}

/** The second write of a move failed; `restored` says whether the old key link came back. */
export class KeyMoveError extends Error {
  constructor(
    readonly reason: unknown,
    readonly restored: boolean,
  ) {
    super('the key link did not move');
  }
}

/**
 * Moves the key: the changes keyChanges gives, sent in order through `send` (one PATCH, which
 * answers the row). The two cannot be one write (the unique index refuses a second key, and the
 * navigation API writes one row), so when the second fails after the first cleared the old key,
 * the old key is set again, from the version (or the pending change) the first write answered,
 * and the error says whether that worked: a half move never passes unreported. Answers whether
 * any write was staged as a pending change.
 */
export async function moveKey(
  changes: readonly KeyChange[],
  send: (id: string, write: RowWrite) => Promise<Row>,
  staged: boolean,
): Promise<boolean> {
  let pending = false;
  let cleared: { change: KeyChange; answer: Row } | null = null;
  for (const change of changes) {
    let answer: Row;
    try {
      answer = await send(change.id, rowWrite({ isKey: change.isKey }, change, staged));
    } catch (err) {
      if (!cleared) throw err;
      let restored = false;
      try {
        const back = {
          version: Number(cleared.answer['version'] ?? cleared.change.version),
          pending: pendingOf(cleared.answer),
        };
        await send(cleared.change.id, rowWrite({ isKey: true }, back, staged));
        restored = true;
      } catch {
        // Said by the error: the menu has no key link until one is starred.
      }
      throw new KeyMoveError(err, restored);
    }
    pending ||= Boolean(answer['draft']);
    if (!change.isKey && changes.length > 1) cleared = { change, answer };
  }
  return pending;
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

/** The most rows one read asks for (ListQuerySchema's limit). */
export const MENU_PAGE = 100;
/** Pages read before the card stops: past this the list is not whole, and moves are refused. */
export const MENU_PAGES_MAX = 20;

/** The header menu as the card reads it. */
export interface MenuRead {
  rows: Row[];
  /** The first answer was read through the release (the screen's mode, R12b). */
  staged: boolean;
  /** Every row was read. Moves renumber the whole list, so they wait for a whole one. */
  complete: boolean;
}

/**
 * Every row of the header menu, read page by page: the API answers at most MENU_PAGE rows, and
 * a move renumbers every link from the list it read, so a list cut at the limit would renumber
 * from part of the menu.
 */
export async function readMenu(
  fetchPage: (offset: number) => Promise<Readonly<Record<string, unknown>>>,
  throughRelease: (answer: unknown) => boolean,
): Promise<MenuRead> {
  const rows: Row[] = [];
  let staged = false;
  for (let page = 0; page < MENU_PAGES_MAX; page += 1) {
    const answer = await fetchPage(rows.length);
    if (page === 0) staged = throughRelease(answer);
    const got = Array.isArray(answer['rows']) ? (answer['rows'] as Row[]) : [];
    rows.push(...got);
    const total = typeof answer['total'] === 'number' ? answer['total'] : null;
    const done = total === null ? got.length < MENU_PAGE : rows.length >= total;
    if (got.length === 0 || done) return { rows, staged, complete: true };
  }
  return { rows, staged, complete: false };
}

/** What a change of the card did: nothing, a live write, or a staged one (releases on). */
export type Wrote = 'none' | 'live' | 'pending';

/** What the card says after a change: a toast only when something was written. */
export function afterChange(
  wrote: Wrote,
  done: string,
): { toast: string | null; announce: boolean } {
  return {
    toast: wrote === 'none' ? null : done,
    announce: wrote === 'pending',
  };
}
