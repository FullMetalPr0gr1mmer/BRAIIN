import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { movable, swapTarget } from '@/components/admin/screens/resources/reorder';
import { RESOURCES } from '@/lib/admin/resources';
import { RESOURCE_UI } from '@/lib/admin/uiSchema';

// Move up and Move down on a resource list (ResourceTable, Admin v2 hotfix H12). A move swaps
// two rows' sort_order and the route writes both; the archive gates let only an Admin write a
// row that stays archived, so anyone else's move steps over archived rows, an archived row
// does not move, and a button with nothing to swap with is disabled.

type Row = { id: string; status?: string };

/** A list from a string, one row per letter: L live (draft), P published, A archived, N none. */
const list = (shape: string): Row[] =>
  [...shape].map((kind, i) => {
    const id = `r${i}`;
    if (kind === 'N') return { id };
    return { id, status: { L: 'draft', P: 'published', A: 'archived' }[kind]! };
  });

/** Every row's [up, down] targets, null where its button is disabled. */
const targets = (rows: Row[], canArchive: boolean) =>
  rows.map((_, i) => [swapTarget(rows, i, -1, canArchive), swapTarget(rows, i, 1, canArchive)]);

describe('movable: the rows a move may write', () => {
  it('an archived row only for a person who may archive; every other row for anyone', () => {
    expect(movable({ status: 'archived' }, false)).toBe(false);
    expect(movable({ status: 'archived' }, true)).toBe(true);
    for (const status of ['draft', 'scheduled', 'published']) {
      expect(movable({ status }, false), status).toBe(true);
    }
    // A row without a lifecycle (a client, a sector) is never archived.
    expect(movable({}, false)).toBe(true);
  });
});

describe('swapTarget without archive rights (a Content Creator)', () => {
  it('steps over an archived neighbour to the nearest row that is not archived', () => {
    const rows = list('LAL');
    expect(swapTarget(rows, 0, 1, false)).toBe(2);
    expect(swapTarget(rows, 2, -1, false)).toBe(0);
  });

  it('steps over a run of archived rows, in both directions', () => {
    const rows = list('PAAAL');
    expect(swapTarget(rows, 0, 1, false)).toBe(4);
    expect(swapTarget(rows, 4, -1, false)).toBe(0);
  });

  it('never moves an archived row', () => {
    const rows = list('LAL');
    expect(swapTarget(rows, 1, -1, false)).toBeNull();
    expect(swapTarget(rows, 1, 1, false)).toBeNull();
  });

  it('has no target (its button is disabled) when only archived rows lie that way', () => {
    expect(targets(list('ALA'), false)).toEqual([
      [null, null],
      [null, null],
      [null, null],
    ]);
    expect(targets(list('LLA'), false)).toEqual([
      [null, 1],
      [0, null],
      [null, null],
    ]);
  });

  it('a list with nothing archived moves as it always did', () => {
    expect(targets(list('LPN'), false)).toEqual([
      [null, 1],
      [0, 2],
      [1, null],
    ]);
  });

  it('never names an archived row, wherever the move starts', () => {
    const rows = list('ALAALPAN');
    for (const [i] of rows.entries()) {
      for (const direction of [-1, 1] as const) {
        const at = swapTarget(rows, i, direction, false);
        if (at === null) continue;
        expect(rows[i]!.status, `row ${i}`).not.toBe('archived');
        expect(rows[at]!.status, `row ${i} → ${at}`).not.toBe('archived');
        // The nearest one: nothing it may write lies between the two.
        const between = rows.slice(Math.min(i, at) + 1, Math.max(i, at));
        expect(between.every((row) => row.status === 'archived')).toBe(true);
      }
    }
  });
});

describe('swapTarget with archive rights (an Admin)', () => {
  it('swaps with the next row, archived or not, as before H12', () => {
    expect(targets(list('LAL'), true)).toEqual([
      [null, 1],
      [0, 2],
      [1, null],
    ]);
  });
});

describe('swapTarget at the edges', () => {
  it('has no target off the page or for an index it does not hold', () => {
    expect(swapTarget([], 0, 1, true)).toBeNull();
    expect(swapTarget(list('L'), 0, -1, true)).toBeNull();
    expect(swapTarget(list('L'), 0, 1, false)).toBeNull();
    expect(swapTarget(list('LL'), 5, -1, true)).toBeNull();
  });
});

describe('ResourceTable uses it', () => {
  it('for the move and for both buttons’ disabled state', () => {
    const source = readFileSync('src/components/admin/screens/resources/ResourceTable.tsx', 'utf8');
    expect(source).toContain('swapTarget(rows, index, direction, canArchive)');
    expect(source).toContain('disabled={swapTarget(rows, index, -1, canArchive) === null}');
    expect(source).toContain('disabled={swapTarget(rows, index, 1, canArchive) === null}');
  });

  it('every list that reorders rows with a lifecycle is told whether its person may archive', () => {
    // Derived, so a list that gains Move up and Move down later is held to it too.
    const pages = Object.keys(RESOURCES).filter(
      (slug) => RESOURCE_UI[slug]?.reorder === true && RESOURCES[slug]!.statusOf !== undefined,
    );
    expect(pages).toEqual([
      'ai-questions',
      'ai-styles',
      'certifications',
      'disciplines',
      'portfolio',
      'services',
      'statistics',
      'team',
      'testimonials',
    ]);
    for (const page of pages) {
      const source = readFileSync(`src/pages/admin/${page}/index.astro`, 'utf8');
      expect(source, page).toContain("can(role, 'content.archiveDelete') === 'full'");
      expect(source, page).toContain(
        `<AdminResourceTable client:load resource="${page}" canArchive={canArchive} />`,
      );
    }
  });
});
