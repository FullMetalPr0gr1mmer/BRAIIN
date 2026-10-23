import { describe, expect, it } from 'vitest';
import {
  PendingItemSchema,
  RELEASE_MAX_ITEMS,
  type PendingItem,
  type ReleaseCheck,
} from '@schemas/release';
import {
  buildRows,
  changeKind,
  defaultSelection,
  discardMineWords,
  discardSelectedWords,
  fieldsText,
  includedBecause,
  mayDiscard,
  needsOf,
  previewHref,
  publishedWords,
  refsOf,
  rowCheck,
  rowsByArea,
  savebarCounts,
  savebarLead,
  savebarShown,
  savebarSub,
  selectedRows,
  toggleRow,
  waitingWords,
  whoWords,
  withNeeds,
} from '@/components/admin/screens/release/model';

// The savebar's and the publish dialog's rules (Admin v2 R12; releases.md §7; README P-2,
// P-12, P-15), pure. What a person is shown before they press anything: the server decides
// every publish again.

const id = (n: number) => `77777777-7777-4777-8777-${String(n).padStart(12, '0')}`;

function item(n: number, over: Partial<PendingItem> = {}): PendingItem {
  return PendingItemSchema.parse({
    draftId: id(n),
    draftVersion: 1,
    entityType: 'service',
    entityId: id(100 + n),
    op: 'update',
    area: 'services',
    label: { en: `Service ${n}`, ar: `خدمة ${n}` },
    fields: ['title'],
    updatedBy: id(900),
    updatedByName: 'Amal',
    updatedAt: `2026-10-23T08:${String(59 - n).padStart(2, '0')}:00Z`,
    scheduled: false,
    mine: true,
    publishableByMe: true,
    requiredCaps: ['services.write', 'content.publish'],
    waitingFor: ['admin', 'content_creator'],
    status: null,
    visible: null,
    href: `/admin/services/${id(100 + n)}`,
    fieldLabels: ['Service name'],
    ...over,
  });
}

describe('rows', () => {
  it('group by area in the menu’s order, newest first inside an area', () => {
    const rows = buildRows([
      item(1, { area: 'seo', entityType: 'redirect' }),
      item(2),
      item(3, { area: 'pages', entityType: 'page' }),
      item(4),
    ]);
    expect(rows.map((r) => r.key)).toEqual([id(3), id(2), id(4), id(1)]);
    expect(rowsByArea(rows).map((g) => [g.area, g.rows.length])).toEqual([
      ['pages', 1],
      ['services', 2],
      ['seo', 1],
    ]);
  });

  it('every sort-only edit of one list is one row, "New order", ticked as one', () => {
    const order = (n: number) => item(n, { fields: ['sort_order'], fieldLabels: ['Sort order'] });
    const rows = buildRows([order(1), item(2), order(3), order(4)]);
    expect(rows).toHaveLength(2);
    const [reorder, edit] = rows;
    expect(reorder).toMatchObject({
      label: 'New order: Services',
      kind: 'reordered',
      fieldsText: '3 moved',
    });
    expect(reorder!.items.map((i) => i.draftId)).toEqual([id(1), id(3), id(4)]);
    expect(edit!.key).toBe(id(2));
    // Counts count the list once (releases.md §7: reorders of one list count once).
    expect(savebarCounts(rows).publishable).toBe(2);
  });

  it('a label falls back to the Arabic, then to the type; an equal Arabic is not repeated', () => {
    expect(buildRows([item(1, { label: { ar: 'شعار' } })])[0]!.label).toBe('شعار');
    expect(buildRows([item(1, { label: null })])[0]!.label).toBe('Services');
    expect(buildRows([item(1, { label: { en: 'Logo', ar: 'Logo' } })])[0]!.labelAr).toBeNull();
    expect(buildRows([item(1)])[0]!.labelAr).toBe('خدمة 1');
  });

  it('a change’s badge comes from what it stores', () => {
    expect(changeKind(item(1, { op: 'create' }))).toBe('new');
    expect(changeKind(item(1, { op: 'delete' }))).toBe('removed');
    expect(changeKind(item(1, { status: 'archived' }))).toBe('archived');
    expect(changeKind(item(1, { status: 'published' }))).toBe('published');
    expect(changeKind(item(1, { status: 'draft' }))).toBe('hidden');
    expect(changeKind(item(1, { visible: true }))).toBe('shown');
    expect(changeKind(item(1, { visible: false }))).toBe('hidden');
    expect(changeKind(item(1, { fields: ['sort_order'] }))).toBe('reordered');
    expect(changeKind(item(1))).toBe('changed');
  });

  it('fields in words: two names, then how many more', () => {
    expect(fieldsText([])).toBe('');
    expect(fieldsText(['Title'])).toBe('Title');
    expect(fieldsText(['Title', 'Intro'])).toBe('Title, Intro');
    expect(fieldsText(['Title', 'Intro', 'Poster', 'Clip'])).toBe('Title, Intro, +2');
  });
});

describe('the savebar', () => {
  it('counts what I may publish, what waits, and my own changes', () => {
    const rows = buildRows([
      item(1),
      item(2, { publishableByMe: false, waitingFor: ['admin'], mine: false, status: 'archived' }),
      item(3, { area: 'pages', entityType: 'page' }),
      item(4, { scheduled: true }),
    ]);
    const counts = savebarCounts(rows);
    expect(counts).toEqual({
      publishable: 2,
      waiting: 1,
      scheduled: 1,
      mine: 2,
      byArea: { services: 1, pages: 1 },
    });
    expect(savebarLead(counts)).toBe('You have 2 unpublished changes');
    expect(savebarSub(counts)).toBe(
      '1 in Pages · 1 in Services · +1 waiting for someone who can publish',
    );
    expect(savebarShown(counts)).toBe(true);
  });

  it('with nothing mine to publish it says who the changes wait for', () => {
    const counts = savebarCounts(buildRows([item(1, { publishableByMe: false, mine: false })]));
    expect(savebarLead(counts)).toBe('1 unpublished change waiting for someone who can publish it');
    expect(savebarSub(counts)).toBe('');
  });

  it('nothing pending shows nothing', () => {
    const counts = savebarCounts([]);
    expect(savebarShown(counts)).toBe(false);
    expect(savebarLead(counts)).toBe('No unpublished changes');
  });

  it('the words carry no dash (P-12)', () => {
    const counts = savebarCounts(buildRows([item(1), item(2, { publishableByMe: false })]));
    for (const words of [savebarLead(counts), savebarSub(counts), discardMineWords(3)]) {
      expect(words).not.toMatch(/[\u2013\u2014]/);
    }
  });
});

describe('who may do what (UX only)', () => {
  it('waiting rows name who can publish them', () => {
    const [row] = buildRows([item(1, { publishableByMe: false, waitingFor: ['admin'] })]);
    expect(waitingWords(row!)).toBe('Needs an Admin');
    expect(whoWords(['admin', 'developer'])).toBe('an Admin or a Developer');
    expect(whoWords(['admin', 'content_creator', 'seo'])).toBe(
      'an Admin, a Content Creator or SEO',
    );
    const [scheduled] = buildRows([item(1, { scheduled: true })]);
    expect(waitingWords(scheduled!)).toBe('Scheduled: locked until it goes live');
  });

  it('a discard follows the type’s author capabilities (app.can_author)', () => {
    expect(mayDiscard('content_creator', item(1))).toBe(true);
    expect(mayDiscard('seo', item(1))).toBe(false);
    expect(mayDiscard('seo', item(1, { entityType: 'entity_seo', area: 'seo' }))).toBe(true);
    expect(mayDiscard('developer', item(1, { entityType: 'site_profile', area: 'settings' }))).toBe(
      true,
    );
    expect(mayDiscard('sales', item(1))).toBe(false);
  });
});

describe('the selection', () => {
  it('ticks everything I may publish, and nothing that waits or is scheduled (O-4)', () => {
    const rows = buildRows([
      item(1),
      item(2, { publishableByMe: false }),
      item(3, { scheduled: true }),
    ]);
    const { ids, capped } = defaultSelection(rows);
    expect([...ids]).toEqual([id(1)]);
    expect(capped).toBe(false);
    expect(refsOf(rows, ids)).toEqual([{ draftId: id(1), draftVersion: 1 }]);
  });

  it('at most one release: 60 changes, rows never split (P-15)', () => {
    const many = Array.from({ length: RELEASE_MAX_ITEMS + 5 }, (_, n) => item(n + 1));
    const { ids, capped } = defaultSelection(buildRows(many));
    expect(ids.size).toBe(RELEASE_MAX_ITEMS);
    expect(capped).toBe(true);
    // A reorder of three never splits across the line.
    const order = (n: number) => item(n, { fields: ['sort_order'] });
    const rows = buildRows([item(1), item(2), order(3), order(4), order(5)]);
    expect(defaultSelection(rows, 4).ids.size).toBe(2);
  });

  it('ticks what a change needs, says why, and unticking it unticks what needs it', () => {
    const rows = buildRows([item(1), item(2, { op: 'create' }), item(3, { op: 'create' })]);
    const check: ReleaseCheck = {
      ok: false,
      dryRun: 'skipped',
      errors: [],
      items: [
        {
          draftId: id(1),
          draftVersion: 1,
          entityType: 'service',
          entityId: id(101),
          op: 'update',
          area: 'services',
          label: null,
          errors: [{ code: 'requires', message: 'It needs a new item you left out.' }],
          warnings: [],
          requires: [{ draftId: id(2), draftVersion: 1 }],
        },
      ],
    };
    const needs = needsOf(check);
    const only1 = new Set([id(1)]);
    const { ids, added } = withNeeds(rows, only1, needs);
    expect([...ids].sort()).toEqual([id(1), id(2)]);
    expect(added).toEqual([id(2)]);
    expect(
      includedBecause(
        rows,
        ids,
        rows.find((r) => r.key === id(2))!,
        needs,
      ),
    ).toBe('Included because “\u2068Service 1\u2069” needs it');
    // Unticking the needed one unticks its dependant too.
    const after = toggleRow(
      rows,
      ids,
      rows.find((r) => r.key === id(2))!,
      false,
      needs,
    );
    expect([...after]).toEqual([]);
    // A needed change the person may not publish is never ticked for them.
    const waiting = buildRows([item(1), item(2, { op: 'create', publishableByMe: false })]);
    expect([...withNeeds(waiting, only1, needs).ids]).toEqual([id(1)]);
    // A waiting row cannot be ticked by hand either.
    expect([...toggleRow(waiting, only1, waiting[1]!, true, needs)]).toEqual([id(1)]);
  });

  it('a change the person unticked is never ticked back: what needs it leaves with it', () => {
    const rows = buildRows([item(1), item(2, { op: 'create' })]);
    const needs = new Map([[id(1), [id(2)]]]);
    // The person unticked 2; the check then says 1 needs it.
    const { ids, added, dropped } = withNeeds(rows, new Set([id(1)]), needs, new Set([id(2)]));
    expect([...ids]).toEqual([]);
    expect(added).toEqual([]);
    expect(dropped).toEqual([id(1)]);
    // Ticked again by hand, it is no longer refused, and it is kept.
    expect([...withNeeds(rows, new Set([id(1), id(2)]), needs, new Set()).ids].sort()).toEqual([
      id(1),
      id(2),
    ]);
  });

  it('counts the selection in rows, as the bar does (a reordered list is one)', () => {
    const order = (n: number) => item(n, { fields: ['sort_order'] });
    const rows = buildRows([item(1), order(2), order(3)]);
    expect(selectedRows(rows, new Set([id(1), id(2), id(3)]))).toBe(2);
    // Half a reorder is no row (rows are ticked whole).
    expect(selectedRows(rows, new Set([id(2)]))).toBe(0);
  });
});

describe('the check per row', () => {
  const base = {
    draftVersion: 1,
    entityType: 'service' as const,
    entityId: id(101),
    op: 'update' as const,
    area: 'services' as const,
    label: null,
    warnings: [],
    requires: [],
  };
  const [row] = buildRows([item(1)]);

  it('unchecked until checked; ready; a warning; an error first', () => {
    expect(rowCheck(row!, null).state).toBe('unchecked');
    const ok: ReleaseCheck = {
      ok: true,
      dryRun: 'ran',
      errors: [],
      items: [{ ...base, draftId: id(1), errors: [] }],
    };
    expect(rowCheck(row!, ok).state).toBe('ready');
    const warn: ReleaseCheck = {
      ...ok,
      items: [
        {
          ...base,
          draftId: id(1),
          errors: [],
          warnings: [{ code: 'hidden-by-discipline', message: 'It stays hidden.' }],
        },
      ],
    };
    expect(rowCheck(row!, warn)).toMatchObject({
      state: 'warning',
      messages: ['It stays hidden.'],
    });
    const bad: ReleaseCheck = {
      ...ok,
      ok: false,
      items: [
        {
          ...base,
          draftId: id(1),
          errors: [{ code: 'invalid', message: 'Add the Arabic title.' }],
        },
      ],
    };
    expect(rowCheck(row!, bad)).toMatchObject({
      state: 'error',
      messages: ['Add the Arabic title.'],
    });
  });

  it('a conflict names its columns; a removed row says so', () => {
    const conflict: ReleaseCheck = {
      ok: false,
      dryRun: 'ran',
      errors: [],
      items: [
        {
          ...base,
          draftId: id(1),
          errors: [{ code: 'conflict', message: 'Changed on the live site.' }],
          conflict: { draftId: id(1), columns: ['title'] },
        },
      ],
    };
    expect(rowCheck(row!, conflict)).toMatchObject({
      state: 'conflict',
      conflict: { draftId: id(1), columns: ['title'] },
    });
    const removed: ReleaseCheck = {
      ...conflict,
      items: [{ ...base, draftId: id(1), errors: [], conflict: { draftId: id(1), removed: true } }],
    };
    expect(rowCheck(row!, removed)).toMatchObject({ state: 'conflict', removed: true });
  });
});

describe('the words of an outcome', () => {
  it('a publish says whether the website shows it yet, truthfully about the cache', () => {
    expect(publishedWords(7, 'done')).toBe('Published v7. The website now shows these changes.');
    expect(publishedWords(7, 'skipped')).toBe('Published v7. The website now shows these changes.');
    expect(publishedWords(7, 'pending')).toContain('may show the old version');
    expect(publishedWords(7, 'failed')).toContain('tries again by itself');
  });

  it('a discard of others’ changes names them', () => {
    const rows = buildRows([item(1), item(2, { mine: false, updatedByName: 'Omar' })]);
    expect(discardSelectedWords(rows, new Set([id(1)]))).toBe(
      'Discard 1 change? They will be thrown away. The live site doesn’t change. This can’t be undone.',
    );
    expect(discardSelectedWords(rows, new Set([id(1), id(2)]))).toContain(
      'This includes 1 change by Omar.',
    );
  });

  it('Preview selection opens the preview of exactly the ticked changes', () => {
    expect(previewHref(new Set())).toBe('/admin/preview/');
    expect(previewHref(new Set([id(1), id(2)]))).toBe(`/admin/preview/?only=${id(1)},${id(2)}`);
  });
});
