import { describe, expect, it } from 'vitest';
import {
  ORDER_STEP,
  orderChanges,
  placeAfter,
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

describe('placeAfter: a duplicate goes right after its original', () => {
  it('after the original, wherever the copy was', () => {
    expect(placeAfter(['a', 'b', 'c', 'copy'], 'a', 'copy')).toEqual(['a', 'copy', 'b', 'c']);
    expect(placeAfter(['a', 'b', 'c', 'copy'], 'c', 'copy')).toEqual(['a', 'b', 'c', 'copy']);
  });

  it('last when the original is gone', () => {
    expect(placeAfter(['a', 'copy', 'b'], 'gone', 'copy')).toEqual(['a', 'b', 'copy']);
  });

  it('a duplicate of the first of many costs the rows after it, not the list', () => {
    const list = Array.from({ length: 20 }, (_, i) => ({ id: `r${i}`, sort_order: (i + 1) * 10 }));
    const order = placeAfter([...list.map((r) => r.id), 'copy'], 'r17', 'copy');
    const changes = orderChanges([...list, { id: 'copy', sort_order: 180 }], order);
    // r18 and r19 move down one place; the copy takes r18's.
    expect(changes).toEqual([
      { id: 'copy', sortOrder: 190 },
      { id: 'r18', sortOrder: 200 },
      { id: 'r19', sortOrder: 210 },
    ]);
  });
});
