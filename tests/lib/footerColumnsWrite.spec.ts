import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FOOTER_COLUMNS_FULL,
  FOOTER_COLUMNS_MAX,
  FOOTER_COLUMNS_PUBLISH_FIRST,
  FOOTER_HEADING_MOVE_FIRST,
} from '@schemas/admin';
import { collectionRoutes, itemRoutes } from '@/lib/admin/resource';
import { navigationResource } from '@/lib/admin/resources/navigation';
import { resetIds, T, type Db, type Row } from '../fixtures/stagedDb';
import { callRoute, draftRow, liveWritesOf, makeDb } from '../fixtures/stagedRoute';

vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));

// A footer column through the navigation API (Admin v2 E6 code review, CR3 and CR4). The
// update schema names only what a write changes, so the row it leaves is judged over the stored
// one, live or staged (navigationResource.assertWritable): a link keeps its address and the
// refusal is said on the address; a heading has no link, sits at the top of the footer and is
// never the key link; a fifth column is refused when it is staged. Releases off and on, over
// the PostgREST stand-in.
//
// With releases on, the count is the PEAK apply_release (0112) passes through, not the state it
// leaves (E6 release-mode check, round 2): the apply writes new and changed rows first and
// removals last, so a pending removal or a column turned back into a link frees no place in the
// same release, and it writes parent_id in a second pass, so a link under another row is not
// made a heading in one change. Releases off, the write is one statement and stays as it was.
// The release's own check (validate.ts) is tests/lib/footerColumnsRelease.spec.ts.

const id = (n: number) => `44444444-4444-4444-8444-${String(n).padStart(12, '0')}`;
const LABEL = { en: 'Studio', ar: 'الاستوديو' };

const navRow = (n: number, over: Row = {}): Row => ({
  id: id(n),
  tenant_id: T,
  location: 'footer',
  parent_id: null,
  label: { en: `Row ${n}`, ar: `صف ${n}` },
  href: `/row-${n}`,
  visible: true,
  is_key: false,
  is_heading: false,
  sort_order: n * 10,
  version: 1,
  created_at: '2026-11-01T08:00:00Z',
  updated_at: '2026-11-01T08:00:00Z',
  ...over,
});
const headingRow = (n: number, over: Row = {}) =>
  navRow(n, { href: null, is_heading: true, ...over });

/** A footer with `headings` columns (one of them hidden) and two links, releases on or off. */
function footer(headings: number, releases: boolean): Db {
  const db = makeDb({
    navigation: [
      ...Array.from({ length: headings }, (_, i) => headingRow(i + 1, { visible: i !== 0 })),
      navRow(50),
      navRow(51),
    ],
  });
  db.flag = releases;
  return db;
}

const post = (db: Db, body: Row, staged: boolean) =>
  callRoute(
    db,
    collectionRoutes(navigationResource).POST,
    'POST',
    `/api/admin/navigation${staged ? '?staged=1' : ''}`,
    { body },
  );
const patch = (db: Db, n: number, body: Row) =>
  callRoute(db, itemRoutes(navigationResource).PATCH, 'PATCH', `/api/admin/navigation/${id(n)}`, {
    body,
    params: { id: id(n) },
  });
const drafts = (db: Db) => db.tables['content_drafts'] ?? [];
const column = { location: 'footer', label: LABEL, isHeading: true };

beforeEach(() => resetIds());

describe.each([
  ['releases off', false],
  ['releases on', true],
])('the footer’s four columns, %s', (_name, releases) => {
  it('a fourth column is taken', async () => {
    const db = footer(FOOTER_COLUMNS_MAX - 1, releases);
    const res = await post(db, column, releases);
    expect(res.status).toBe(200);
    if (releases) expect(drafts(db)).toHaveLength(1);
    else expect(liveWritesOf(db, 'navigation')).toHaveLength(1);
  });

  it('a fifth is a 422 on the heading flag, a hidden column counted; nothing written', async () => {
    const db = footer(FOOTER_COLUMNS_MAX, releases);
    const res = await post(db, column, releases);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ field: 'isHeading', detail: FOOTER_COLUMNS_FULL });
    expect(drafts(db)).toEqual([]);
    expect(liveWritesOf(db, 'navigation')).toEqual([]);
  });

  it('a link turned into a fifth column is refused the same way', async () => {
    const db = footer(FOOTER_COLUMNS_MAX, releases);
    const res = await patch(db, 50, { isHeading: true, href: null, version: 1 });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ field: 'isHeading', detail: FOOTER_COLUMNS_FULL });
    expect(drafts(db)).toEqual([]);
    expect(liveWritesOf(db, 'navigation')).toEqual([]);
  });

  it('a column already there is edited and hidden at four, never counted against itself', async () => {
    const db = footer(FOOTER_COLUMNS_MAX, releases);
    expect((await patch(db, 2, { label: LABEL, version: 1 })).status).toBe(200);
    // The edit above may have staged a change; the eye on another column is its own write.
    expect((await patch(db, 3, { visible: false, version: 1 })).status).toBe(200);
    // A heading restated as a heading is not a new column either.
    expect((await patch(db, 4, { isHeading: true, version: 1 })).status).toBe(200);
  });

  it('an emptied link address is a 422 on the address, not on the heading flag (CR4)', async () => {
    const db = footer(1, releases);
    const res = await patch(db, 50, { href: null, version: 1 });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ field: 'href', detail: 'a link needs an address' });
    expect(drafts(db)).toEqual([]);
    expect(liveWritesOf(db, 'navigation')).toEqual([]);
  });

  it('a link with an address turned into a heading is a 422 on the heading flag', async () => {
    const db = footer(1, releases);
    const res = await patch(db, 50, { isHeading: true, version: 1 });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ field: 'isHeading' });
    expect(String(res.body['detail'])).toMatch(/has an address/);
    expect(drafts(db)).toEqual([]);
  });

  it('a heading moved under a row, given a link or made the key: the field the write sent', async () => {
    const db = footer(1, releases);
    for (const [body, field] of [
      [{ parentId: id(50) }, 'parentId'],
      [{ href: '/about' }, 'href'],
      [{ isKey: true }, 'isKey'],
      [{ location: 'header' }, 'location'],
    ] as const) {
      const res = await patch(db, 1, { ...body, version: 1 });
      expect(res.status, field).toBe(422);
      expect(res.body, field).toMatchObject({ field });
    }
    expect(drafts(db)).toEqual([]);
    expect(liveWritesOf(db, 'navigation')).toEqual([]);
  });

  it('a heading turned back into a link takes its address in the same write', async () => {
    const db = footer(1, releases);
    expect((await patch(db, 1, { isHeading: false, version: 1 })).body).toMatchObject({
      field: 'href',
    });
    expect((await patch(db, 1, { isHeading: false, href: '/about', version: 1 })).status).toBe(200);
  });
});

describe('the staged view counts the columns waiting to be published (releases on)', () => {
  const pendingColumn = (n: number) =>
    draftRow({
      id: `77777777-7777-4777-8777-${String(n).padStart(12, '0')}`,
      entity_type: 'nav_item',
      entity_id: id(n),
      op: 'create',
      payload: { location: 'footer', label: LABEL, isHeading: true, visible: true },
      fields: ['location', 'label', 'isHeading', 'visible'],
      base_version: null,
    });

  it('three live and one pending: a new column is refused when it is staged', async () => {
    const db = footer(FOOTER_COLUMNS_MAX - 1, true);
    db.tables['content_drafts'] = [pendingColumn(90)];
    const res = await post(db, column, true);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ field: 'isHeading', detail: FOOTER_COLUMNS_FULL });
    expect(drafts(db)).toHaveLength(1);
  });

  it('four live and a pending removal of one: a new column waits for the removal to publish', async () => {
    const db = footer(FOOTER_COLUMNS_MAX, true);
    db.tables['content_drafts'] = [
      draftRow({ entity_type: 'nav_item', entity_id: id(2), op: 'delete', payload: {} }),
    ];
    const res = await post(db, column, true);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ field: 'isHeading', detail: FOOTER_COLUMNS_PUBLISH_FIRST });
    expect(drafts(db)).toHaveLength(1);
  });

  it('four live and one pending back to a link: a link made a column waits the same way', async () => {
    const db = footer(FOOTER_COLUMNS_MAX, true);
    db.tables['content_drafts'] = [
      draftRow({
        entity_type: 'nav_item',
        entity_id: id(4),
        op: 'update',
        payload: { isHeading: false, href: '/row-4' },
        fields: ['isHeading', 'href'],
        base: { is_heading: true, href: null },
      }),
    ];
    const res = await patch(db, 50, { isHeading: true, href: null, version: 1 });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ field: 'isHeading', detail: FOOTER_COLUMNS_PUBLISH_FIRST });
    expect(drafts(db)).toHaveLength(1);
  });

  it('three live and a pending removal of one: a fourth still finds its place', async () => {
    const db = footer(FOOTER_COLUMNS_MAX - 1, true);
    db.tables['content_drafts'] = [
      draftRow({ entity_type: 'nav_item', entity_id: id(2), op: 'delete', payload: {} }),
    ];
    const res = await post(db, column, true);
    expect(res.status).toBe(200);
    expect(drafts(db)).toHaveLength(2);
  });

  it('re-saving the pending column itself is not counted against itself', async () => {
    const db = footer(FOOTER_COLUMNS_MAX - 1, true);
    db.tables['content_drafts'] = [pendingColumn(90)];
    const res = await patch(db, 90, {
      label: { en: 'Work', ar: 'الأعمال' },
      draftId: '77777777-7777-4777-8777-000000000090',
      draftVersion: 1,
    });
    expect(res.status).toBe(200);
  });
});

describe('a link under another row made a column heading', () => {
  /** Three columns, a top-level link (50) and a link under it (51). */
  const nested = (releases: boolean) => {
    const db = footer(FOOTER_COLUMNS_MAX - 1, releases);
    db.tables['navigation'] = db.tables['navigation']!.map((row) =>
      row['id'] === id(51) ? { ...row, parent_id: id(50) } : row,
    );
    return db;
  };
  const promote = { isHeading: true, href: null, parentId: null, version: 1 };

  it('releases off: one write moves it to the top and makes it a heading (as before)', async () => {
    const db = nested(false);
    const res = await patch(db, 51, promote);
    expect(res.status).toBe(200);
    expect(liveWritesOf(db, 'navigation')).toHaveLength(1);
  });

  it('releases on: refused when it is staged, its move published first', async () => {
    const db = nested(true);
    const res = await patch(db, 51, promote);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ field: 'isHeading', detail: FOOTER_HEADING_MOVE_FIRST });
    expect(drafts(db)).toEqual([]);
  });

  it('releases on: a link already at the top is made a heading in one change', async () => {
    const db = nested(true);
    const res = await patch(db, 50, { isHeading: true, href: null, version: 1 });
    expect(res.status).toBe(200);
    expect(drafts(db)).toHaveLength(1);
  });
});
