import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  isArchiveRefusal,
  movable,
  MOVE_ARCHIVED,
  swapTarget,
} from '@/components/admin/screens/resources/reorder';
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

describe('a refused move (the list went stale)', () => {
  // The buttons know only the list as it loaded: an item archived since by someone else is
  // still offered, and the route refuses the move (403 content.archiveDelete).
  it('isArchiveRefusal: a 403 naming content.archiveDelete, and nothing else', () => {
    expect(isArchiveRefusal('forbidden', 'content.archiveDelete')).toBe(true);
    expect(isArchiveRefusal('forbidden', 'services.write')).toBe(false);
    expect(isArchiveRefusal('forbidden', undefined)).toBe(false);
    expect(isArchiveRefusal('validation', 'content.archiveDelete')).toBe(false);
    expect(isArchiveRefusal('conflict', undefined)).toBe(false);
  });

  it('says why, and that the list shown is the stored order, never that a later move repairs it', () => {
    expect(MOVE_ARCHIVED).toMatch(/archived/);
    expect(MOVE_ARCHIVED).toMatch(/only an Admin/);
    expect(MOVE_ARCHIVED).toMatch(/reloaded/);
    expect(MOVE_ARCHIVED).not.toMatch(/repair/i);
  });
});

describe('ResourceTable uses it', () => {
  const source = () =>
    readFileSync('src/components/admin/screens/resources/ResourceTable.tsx', 'utf8');

  it('for the move and for both buttons’ disabled state', () => {
    expect(source()).toContain('swapTarget(rows, index, direction, canArchive)');
    expect(source()).toContain('disabled={swapTarget(rows, index, -1, canArchive) === null}');
    expect(source()).toContain('disabled={swapTarget(rows, index, 1, canArchive) === null}');
  });

  it('re-reads the list when a move is refused, then says why (load() clears the message)', () => {
    // The move's own catch: the list is re-read first, so its statuses, numbers and buttons
    // are the stored ones (an item archived since is then stepped over), and the message is
    // set after load(), which clears it as it starts.
    const move = /async function move\([\s\S]*?\n {2}\}\n/.exec(source())?.[0] ?? '';
    const caught = /\} catch \(err\) \{([\s\S]*)\}\s*\}\s*$/.exec(move)?.[1] ?? '';
    expect(caught, 'the move has a catch').not.toBe('');
    const reload = caught.indexOf('await load();');
    const message = caught.indexOf('setError(');
    expect(reload, 'the catch re-reads the list').toBeGreaterThanOrEqual(0);
    expect(message, 'the catch says why').toBeGreaterThan(reload);
    expect(caught).toContain('isArchiveRefusal(');
    expect(caught).toContain('MOVE_ARCHIVED');
  });

  it('every list that reorders rows with a lifecycle is told whether its person may archive', () => {
    // Derived, so a list that gains Move up and Move down later is held to it too. Two screens
    // draw such a list: ResourceTable (this helper, told by `canArchive`) and U7's collection
    // screen (its own `renumberable`, told by the session's `permissions.remove`).
    const pages = Object.keys(RESOURCES).filter(
      (slug) => RESOURCE_UI[slug]?.reorder === true && RESOURCES[slug]!.statusOf !== undefined,
    );
    expect(pages).toEqual([
      'ai-questions',
      'ai-styles',
      'certifications',
      'disciplines',
      'faq',
      'portfolio',
      'services',
      'statistics',
      'team',
      'testimonials',
    ]);
    const collection = readFileSync('src/lib/admin/collectionScreen.ts', 'utf8');
    expect(collection).toContain(
      "can(role, config.deleteCap ?? 'content.archiveDelete') === 'full'",
    );
    for (const page of pages) {
      const source = readFileSync(`src/pages/admin/${page}/index.astro`, 'utf8');
      if (/<AdminCollection\s/.test(source)) {
        expect(source, page).toContain(`collectionScreen(Astro.locals.session, '${page}')`);
        expect(source, page).toContain('permissions={screen.permissions}');
        continue;
      }
      expect(source, page).toContain("can(role, 'content.archiveDelete') === 'full'");
      expect(source, page).toContain(
        `<AdminResourceTable client:load resource="${page}" canArchive={canArchive} />`,
      );
    }
  });
});
