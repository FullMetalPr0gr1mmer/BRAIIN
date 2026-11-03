import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FOOTER_COLUMNS_FULL,
  FOOTER_COLUMNS_PUBLISH_FIRST,
  FOOTER_HEADING_MOVE_FIRST,
} from '@schemas/admin';
import { client, T, type Db, type Row } from '../fixtures/stagedDb';
import { ADMIN, callRoute, draftRow, makeDb } from '../fixtures/stagedRoute';

// A release's check of the footer's columns (Admin v2 E6, release-mode check round 2): the
// validate endpoint judges each change over the state the release leaves AND over what
// public.apply_release (0112) passes through, before it asks the database for a dry run. The
// apply writes new and changed rows first, their parent_id in a second pass, and removals last,
// so a release that removes a column and adds one at four, swaps a column for a link at four,
// or makes a link under another row a heading would be refused there, with the whole release
// (supabase/tests/footer_columns.test.sql, section 7, shows the database's side). Here the
// Worker refuses each first: the dry run is never asked. The apply is a scripted answer; the
// staged saves are tests/lib/footerColumnsWrite.spec.ts.

const svc = vi.hoisted(() => ({
  db: null as unknown as Db,
  calls: [] as { fn: string; args: Record<string, unknown> }[],
}));

vi.mock('@/lib/supabase/server', () => ({
  serviceClient: () => ({
    // The person, re-read live: the stand-in's own tables.
    from: (table: string) => client(svc.db).from(table),
    // The dry run: recorded, and clean (a builder like postgrest-js's).
    rpc: (fn: string, args: Record<string, unknown>) => {
      svc.calls.push({ fn, args });
      const answer = () =>
        Promise.resolve({
          data: { mode: 'dry_run', ok: true, item_count: 1, conflicts: [], errors: [] },
          error: null,
        });
      return {
        then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => answer().then(ok, ko),
        abortSignal: () => answer(),
      };
    },
  }),
}));
vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));
vi.mock('@/lib/admin/redirectSync', () => ({
  syncRedirectsOfTenant: async () => ({ kvSynced: true, count: 0, truncated: false }),
}));
vi.mock('@/lib/admin/visibilitySync', () => ({
  rebuildVisibilitySnapshot: async () => ({ snapshot: {}, kvSynced: false }),
}));
const { POST: VALIDATE } = await import('@/pages/api/admin/releases/validate');

const nid = (n: number) => `44444444-4444-4444-8444-${String(n).padStart(12, '0')}`;
const did = (n: number) => `77777777-7777-4777-8777-${String(n).padStart(12, '0')}`;
const navRow = (n: number, over: Row = {}): Row => ({
  id: nid(n),
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
  ...over,
});
const headingRow = (n: number, over: Row = {}) =>
  navRow(n, { href: null, is_heading: true, ...over });
/** Columns 1 to `n` (the first hidden: it counts), a top-level link 50 and a link 51 under it. */
const footer = (n: number): Row[] => [
  ...Array.from({ length: n }, (_, i) => headingRow(i + 1, { visible: i !== 0 })),
  navRow(50),
  navRow(51, { parent_id: nid(50) }),
];

function seed(navigation: Row[], drafts: Row[]): Db {
  const db = makeDb({
    profiles: [{ id: ADMIN, tenant_id: T, role: 'admin', is_active: true, locked_until: null }],
    navigation,
    content_drafts: drafts,
  });
  svc.db = db;
  return db;
}
const select = (...drafts: Row[]) => ({
  items: drafts.map((d) => ({ draftId: d['id'], draftVersion: d['version'] })),
});
const validate = (db: Db, ...drafts: Row[]) =>
  callRoute(db, VALIDATE, 'POST', '/api/admin/releases/validate', { body: select(...drafts) });
const dryRuns = () => svc.calls.filter((c) => c.fn === 'apply_release');

const newColumn = (n: number) =>
  draftRow({
    id: did(n),
    entity_type: 'nav_item',
    entity_id: nid(n),
    op: 'create',
    payload: { location: 'footer', label: { en: 'New', ar: 'جديد' }, isHeading: true },
    fields: ['location', 'label', 'isHeading'],
    base: {},
    base_version: null,
  });
const removal = (n: number) =>
  draftRow({ id: did(n), entity_type: 'nav_item', entity_id: nid(n), op: 'delete', payload: {} });
/** An update of row `n` (live as `live`), its base the live values of what it writes. */
const change = (n: number, payload: Row, base: Row) =>
  draftRow({
    id: did(n),
    entity_type: 'nav_item',
    entity_id: nid(n),
    op: 'update',
    payload,
    fields: Object.keys(payload),
    base,
    base_version: 1,
  });
const backToLink = (n: number) =>
  change(n, { isHeading: false, href: `/row-${n}` }, { is_heading: true, href: null });
const madeColumn = (n: number, parent: string | null = null) =>
  change(
    n,
    { isHeading: true, href: null, parentId: null },
    { is_heading: false, href: `/row-${n}`, parent_id: parent },
  );

/** The one item's report: ok, or its error. */
const errorsOf = (data: Row, draftId: string) =>
  ((data['items'] as Row[]).find((i) => i['draftId'] === draftId)?.['errors'] ?? []) as Row[];

beforeEach(() => {
  svc.calls = [];
});

describe('a release of footer columns, judged before the dry run', () => {
  it('a fifth column is refused by the Worker; the dry run is never asked', async () => {
    const create = newColumn(90);
    const db = seed(footer(4), [create]);
    const res = await validate(db, create);
    expect(res.data).toMatchObject({ ok: false, dryRun: 'skipped' });
    expect(errorsOf(res.data, did(90))).toEqual([
      expect.objectContaining({ field: 'isHeading', message: FOOTER_COLUMNS_FULL }),
    ]);
    expect(dryRuns()).toEqual([]);
  });

  it('the shape is judged over live plus the change: a link keeps its address unless emptied', async () => {
    const promote = change(50, { isHeading: true }, { is_heading: false });
    const db = seed(footer(3), [promote]);
    const res = await validate(db, promote);
    expect(res.data).toMatchObject({ ok: false, dryRun: 'skipped' });
    expect(errorsOf(res.data, did(50))).toEqual([
      expect.objectContaining({
        field: 'isHeading',
        message: 'this link has an address: empty it before it becomes a column heading',
      }),
    ]);
    expect(dryRuns()).toEqual([]);
  });

  it('a column removed and one added at four: the new one waits for the removal (the apply removes last)', async () => {
    const del = removal(2);
    const create = newColumn(90);
    const db = seed(footer(4), [del, create]);
    const res = await validate(db, del, create);
    expect(res.data).toMatchObject({ ok: false, dryRun: 'skipped' });
    expect(errorsOf(res.data, did(90))).toEqual([
      expect.objectContaining({ field: 'isHeading', message: FOOTER_COLUMNS_PUBLISH_FIRST }),
    ]);
    expect(errorsOf(res.data, did(2))).toEqual([]);
    expect(dryRuns()).toEqual([]);
  });

  it('a column swapped for a link at four: refused the same way, whatever the ids’ order', async () => {
    // The apply takes changed rows in id order: link 50 made a column before column 60 turns
    // back into a link is a fifth (the database refuses it); column 4 first would pass there,
    // but the Worker does not lean on an order of random ids.
    for (const back of [60, 4]) {
      svc.calls = [];
      const demote = backToLink(back);
      const promote = madeColumn(50);
      const db = seed([...footer(3), headingRow(back)], [demote, promote]);
      const res = await validate(db, demote, promote);
      expect(res.data, `column ${back}`).toMatchObject({ ok: false, dryRun: 'skipped' });
      expect(errorsOf(res.data, did(50))).toEqual([
        expect.objectContaining({ field: 'isHeading', message: FOOTER_COLUMNS_PUBLISH_FIRST }),
      ]);
      expect(errorsOf(res.data, did(back))).toEqual([]);
      expect(dryRuns()).toEqual([]);
    }
  });

  it('a link under another row made a heading: its move is published first', async () => {
    const promote = madeColumn(51, nid(50));
    const db = seed(footer(3), [promote]);
    const res = await validate(db, promote);
    expect(res.data).toMatchObject({ ok: false, dryRun: 'skipped' });
    expect(errorsOf(res.data, did(51))).toEqual([
      expect.objectContaining({ field: 'isHeading', message: FOOTER_HEADING_MOVE_FIRST }),
    ]);
    expect(dryRuns()).toEqual([]);
  });

  it('what the apply accepts passes to the dry run: a removal alone, a fourth, a top-level link made one', async () => {
    for (const [rows, draft] of [
      [footer(4), removal(2)],
      [footer(3), newColumn(90)],
      [footer(3), madeColumn(50)],
      [footer(4), backToLink(4)],
    ] as const) {
      svc.calls = [];
      const db = seed([...rows], [draft]);
      const res = await validate(db, draft);
      expect(res.data, String(draft['id'])).toMatchObject({ ok: true, dryRun: 'ran' });
      expect(dryRuns()).toHaveLength(1);
    }
  });

  it('live is read once for the release, however many columns it adds', async () => {
    const one = newColumn(90);
    const two = newColumn(91);
    const db = seed(footer(2), [one, two]);
    const res = await validate(db, one, two);
    expect(res.data).toMatchObject({ ok: true, dryRun: 'ran' });
    const liveHeadingReads = db.calls.filter(
      (c) =>
        c.kind === 'from' && c.name === 'navigation' && c.op === 'select' && c.columns === 'id',
    );
    expect(liveHeadingReads).toHaveLength(1);
  });
});
