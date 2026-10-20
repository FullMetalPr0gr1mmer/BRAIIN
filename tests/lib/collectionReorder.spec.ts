import { describe, expect, it } from 'vitest';
import {
  ORDER_STEP,
  duplicateChanges,
  orderChanges,
  renumberable,
  type OrderChange,
  type Positioned,
} from '@/components/admin/screens/collection/reorder';

// The collection screen's order (Admin v2 U7, D10): a move renumbers the list in tens and
// sends only the rows whose number changed, because each row is one update and one
// subrequest (README P-15: 50 a request on the Workers Free plan).

const rows = (...orders: number[]) => orders.map((n, i) => ({ id: `r${i + 1}`, sort_order: n }));

describe('orderChanges: the rows a move changes, numbered in tens', () => {
  it('an unchanged order changes nothing', () => {
    expect(orderChanges(rows(10, 20, 30), ['r1', 'r2', 'r3'])).toEqual([]);
  });

  it('a swap of neighbours touches the two rows only', () => {
    expect(orderChanges(rows(10, 20, 30, 40), ['r1', 'r3', 'r2', 'r4'])).toEqual([
      { id: 'r3', sortOrder: 20 },
      { id: 'r2', sortOrder: 30 },
    ]);
  });

  it('a move from the bottom to the top touches the rows between its two ends', () => {
    const changes = orderChanges(rows(10, 20, 30, 40, 50), ['r5', 'r1', 'r2', 'r3', 'r4']);
    expect(changes).toHaveLength(5);
    expect(orderChanges(rows(10, 20, 30, 40, 50), ['r1', 'r2', 'r4', 'r3', 'r5'])).toHaveLength(2);
  });

  it('ties and gaps in the stored numbers settle on the first move', () => {
    // A seed's 1, 2, 3, or two rows at 0: renumbered in tens, after which a move touches
    // only what it passed.
    expect(orderChanges(rows(0, 0, 5), ['r1', 'r2', 'r3'])).toEqual([
      { id: 'r1', sortOrder: 10 },
      { id: 'r2', sortOrder: 20 },
      { id: 'r3', sortOrder: 30 },
    ]);
    expect(ORDER_STEP).toBe(10);
  });

  it('an id the list does not hold is skipped; a row the order leaves out is left alone', () => {
    expect(orderChanges(rows(10, 20), ['ghost', 'r2', 'r1'])).toEqual([
      { id: 'r2', sortOrder: 10 },
      { id: 'r1', sortOrder: 20 },
    ]);
    expect(orderChanges(rows(10, 20, 30), ['r2', 'r1'])).toEqual([
      { id: 'r2', sortOrder: 10 },
      { id: 'r1', sortOrder: 20 },
    ]);
  });
});

// The reorder route applies the updates one at a time (resource.ts), and a public page can
// render between two of them: the ids in display order after each step, ties kept in list
// order as a stable sort keeps them.
function steps(list: readonly Positioned[], changes: readonly OrderChange[]): string[][] {
  const at = new Map(list.map((row) => [row.id, row.sort_order]));
  const show = () =>
    list
      .map((row, index) => ({ id: row.id, n: at.get(row.id)!, index }))
      .sort((a, b) => a.n - b.n || a.index - b.index)
      .map((row) => row.id);
  return changes.map((change) => {
    at.set(change.id, change.sortOrder);
    return show();
  });
}

describe('duplicateChanges: a duplicate goes right after its original (D9)', () => {
  it('a duplicate of one of many costs the copy and the rows after it, not the list', () => {
    const list = Array.from({ length: 20 }, (_, i) => ({ id: `r${i}`, sort_order: (i + 1) * 10 }));
    const changes = duplicateChanges(list, 'r17', { id: 'copy', sort_order: 180 });
    // r18 and r19 move down one place; the copy takes r18's. The last row goes first.
    expect(changes).toEqual([
      { id: 'r19', sortOrder: 210 },
      { id: 'r18', sortOrder: 200 },
      { id: 'copy', sortOrder: 190 },
    ]);
  });

  it('nothing above the original moves, however the seed numbered it', () => {
    // A seed's tied numbers (two sets of 1, 2, 3...): duplicating the second row renumbers
    // only what follows it.
    const list = [
      { id: 'a', sort_order: 1 },
      { id: 'b', sort_order: 1 },
      { id: 'c', sort_order: 2 },
      { id: 'd', sort_order: 2 },
      { id: 'e', sort_order: 3 },
    ];
    const changes = duplicateChanges(list, 'b', { id: 'copy', sort_order: 1 });
    expect(changes.map((c) => c.id).sort()).toEqual(['c', 'copy', 'd', 'e']);
    expect(Object.fromEntries(changes.map((c) => [c.id, c.sortOrder]))).toEqual({
      copy: 11,
      c: 21,
      d: 31,
      e: 41,
    });
  });

  it('a duplicate of the last row moves the copy alone', () => {
    expect(duplicateChanges(rows(1, 2, 9990), 'r3', { id: 'copy', sort_order: 9990 })).toEqual([
      { id: 'copy', sortOrder: 10000 },
    ]);
  });

  it('no row passes another while the updates land one at a time', () => {
    // Rows the copy pushes down, rows whose number falls (a gap above them), both.
    const cases: [Positioned[], string][] = [
      [rows(1, 2, 3, 4, 5, 6), 'r2'],
      [rows(10, 20, 30, 40), 'r1'],
      [rows(1, 5, 100, 120, 125), 'r1'],
      [rows(0, 0, 0, 0), 'r1'],
    ];
    for (const [list, original] of cases) {
      const copy = { id: 'copy', sort_order: list.find((r) => r.id === original)!.sort_order };
      const changes = duplicateChanges(list, original, copy);
      const others = list.map((row) => row.id);
      const settled = [
        ...others.slice(0, others.indexOf(original) + 1),
        'copy',
        ...others.slice(others.indexOf(original) + 1),
      ];
      for (const shown of steps([...list, copy], changes)) {
        // Every listed row keeps its place relative to the others; only the copy travels.
        expect(shown.filter((id) => id !== 'copy')).toEqual(others);
      }
      expect(steps([...list, copy], changes).at(-1)).toEqual(settled);
    }
  });

  it('last when the original is gone', () => {
    expect(duplicateChanges(rows(10, 20), 'gone', { id: 'copy', sort_order: 0 })).toEqual([
      { id: 'copy', sortOrder: 30 },
    ]);
  });
});

// An archived row is written by an Admin only (the RESTRICTIVE archive gates, 0018 on), and
// the reorder route stops at the first refused row: a Content Creator's move over a list that
// holds one (the seed's three archived numbers) was refused whole, 42501.
const positioned = (list: readonly (Positioned & { status?: string })[]): Positioned[] =>
  list.map(({ id, sort_order }) => ({ id, sort_order }));
const ARCHIVED = new Set(['old1', 'old2', 'old3']);

describe('renumberable: an archived row is renumbered by an Admin only', () => {
  // The statistics seed: three archived legacy numbers and four live ones, both 1, 2, 3…,
  // then this run's two drafts at the end.
  const seeded = [
    { id: 'old1', sort_order: 1, status: 'archived' },
    { id: 'a', sort_order: 1, status: 'published' },
    { id: 'old2', sort_order: 2, status: 'archived' },
    { id: 'b', sort_order: 2, status: 'published' },
    { id: 'old3', sort_order: 3, status: 'archived' },
    { id: 'c', sort_order: 3, status: 'published' },
    { id: 'd', sort_order: 4, status: 'scheduled' },
    { id: 'n1', sort_order: 9980, status: 'draft' },
    { id: 'n2', sort_order: 9990, status: 'draft' },
  ];
  // n2 moved one place up, over n1.
  const moved = ['old1', 'a', 'old2', 'b', 'old3', 'c', 'd', 'n2', 'n1'];

  it('keeps every row for a person who may archive and drops the archived ones otherwise', () => {
    expect(renumberable(seeded, true)).toEqual(seeded);
    expect(renumberable(seeded, false).map((row) => row.id)).toEqual([
      'a',
      'b',
      'c',
      'd',
      'n1',
      'n2',
    ]);
  });

  it('keeps a row with no status (a client) whoever moves it', () => {
    const clients = [
      { id: 'x', sort_order: 1 },
      { id: 'y', sort_order: 2 },
    ];
    expect(renumberable(clients, false)).toEqual(clients);
  });

  it("a non-archiver's move names no archived row and numbers the rest in tens, in order", () => {
    const changes = orderChanges(positioned(renumberable(seeded, false)), moved);
    expect(changes.filter((change) => ARCHIVED.has(change.id))).toEqual([]);
    expect(changes).toEqual([
      { id: 'a', sortOrder: 10 },
      { id: 'b', sortOrder: 20 },
      { id: 'c', sortOrder: 30 },
      { id: 'd', sortOrder: 40 },
      { id: 'n2', sortOrder: 50 },
      { id: 'n1', sortOrder: 60 },
    ]);
    // An Admin's renumbers the archived rows too, in their places.
    expect(orderChanges(positioned(renumberable(seeded, true)), moved)).toContainEqual({
      id: 'old1',
      sortOrder: 10,
    });
  });

  it("a non-archiver's duplicate names no archived row after the original", () => {
    const list = [
      { id: 'a', sort_order: 10, status: 'published' },
      { id: 'b', sort_order: 20, status: 'draft' },
      { id: 'old1', sort_order: 30, status: 'archived' },
      { id: 'c', sort_order: 40, status: 'published' },
      { id: 'old2', sort_order: 50, status: 'archived' },
    ];
    const copy = { id: 'copy', sort_order: 10 };
    const changes = duplicateChanges(positioned(renumberable(list, false)), 'a', copy);
    expect(changes.filter((change) => ARCHIVED.has(change.id))).toEqual([]);
    // The copy takes b's place and b takes the next; c already stands at 40.
    expect(changes).toEqual([
      { id: 'b', sortOrder: 30 },
      { id: 'copy', sortOrder: 20 },
    ]);
    // An Admin's pushes the archived rows down with the rest.
    const admin = duplicateChanges(positioned(renumberable(list, true)), 'a', copy);
    expect(admin.map((change) => change.id)).toEqual(['old2', 'c', 'old1', 'b', 'copy']);
  });
});
