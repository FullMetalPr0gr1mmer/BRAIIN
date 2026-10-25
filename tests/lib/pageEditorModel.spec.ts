import { describe, expect, it } from 'vitest';
import { SectionWriteSchema } from '@schemas/admin';
import { SECTION_TYPES } from '@schemas/sectionTypes';
import { ROLES } from '@/lib/auth/types';
import { ROLE_CAPS } from '@/lib/authz/matrix';
import { clockFor } from '@/lib/admin/relTime';
import { sectionStateFromObject } from '@/lib/admin/formPayload';
import { pagesUi } from '@/lib/admin/ui/pages';
import { SECTION_COPY, builtInContent } from '@/lib/sections/copy';
import { RENDERED_SECTION_TYPES } from '@/lib/sections/registry';
import { isVisible, ADMIN_NAV } from '@/lib/admin/nav';
import { builtInLooks, mayOpenPages, pageEditorAccess } from '@/lib/admin/pages/editor';
import {
  PAGE_FIELDS,
  SECTION_CONTENT_FIELD,
  SECTION_TYPE_FIELD,
  builtInFor,
  formSyncAfterWrite,
  inOrder,
  isFirstOfType,
  neighbourAfterRemoval,
  newSectionPayload,
  readsThroughRelease,
  sectionFormFields,
  sectionRowOf,
  variantOf,
  type SectionRow,
} from '@/components/admin/screens/pageEditor/model';
import { historyRows, pageVersionRows } from '@/components/admin/screens/pageEditor/history';

// The page editor's rules (Admin v2 E1): the server half (src/lib/admin/pages/editor.ts: who
// opens it, what each role may do, the built-in copy it hands the island) and the island's
// pure rules (screens/pageEditor/model.ts and history.ts).

const row = (patch: Partial<SectionRow> & { id: string }): SectionRow => ({
  type: 'cta',
  label: null,
  visible: true,
  sortOrder: 10,
  version: 1,
  placeholder: false,
  ...patch,
});

describe('who opens the page editor, and what each role may do there', () => {
  it('opens for exactly the roles holding seo.entityMeta at any access (the locked screen)', () => {
    for (const role of ROLES) {
      expect(mayOpenPages(role), role).toBe(ROLE_CAPS[role]['seo.entityMeta'] !== 'none');
    }
    expect(ROLES.filter(mayOpenPages)).toEqual(['admin', 'content_creator', 'seo']);
  });

  it('opens for exactly the roles whose menu shows Pages', () => {
    const pages = ADMIN_NAV.flatMap((g) => g.links).find((l) => l.href === '/admin/pages')!;
    for (const role of ROLES) expect(mayOpenPages(role), role).toBe(isVisible(role, pages));
  });

  it('gives each role its rights from ROLE_CAPS', () => {
    expect(pageEditorAccess('admin')).toEqual({
      sections: true,
      remove: true,
      publish: true,
      seo: 'full',
      visibility: true,
    });
    expect(pageEditorAccess('content_creator')).toEqual({
      sections: true,
      remove: false,
      publish: true,
      seo: 'view',
      visibility: false,
    });
    expect(pageEditorAccess('seo')).toEqual({
      sections: false,
      remove: false,
      publish: false,
      seo: 'full',
      visibility: false,
    });
  });
});

describe('the built-in copy the server hands the island', () => {
  const looks = builtInLooks();

  it('is every look of every type, F6’s copy, less what is not rendered verbatim', () => {
    expect(Object.keys(looks).sort()).toEqual([...RENDERED_SECTION_TYPES].sort());
    for (const [type, copy] of Object.entries(SECTION_COPY)) {
      expect(Object.keys(looks[type]!).sort(), type).toEqual(Object.keys(copy.content).sort());
      for (const [look, content] of Object.entries(copy.content)) {
        const expected = { ...(content as Record<string, unknown>) };
        for (const field of copy.notVerbatim) delete expected[field];
        expect(looks[type]![look], `${type} ${look}`).toEqual(expected);
      }
    }
    // aboutIntro's tag and heading name the studio through %brand% or bold a run (F6 D5).
    expect(looks['aboutIntro']!['default']).not.toHaveProperty('tag');
    expect(looks['aboutIntro']!['default']).not.toHaveProperty('heading');
    expect(looks['aboutIntro']!['default']).toHaveProperty('lead');
  });

  it('the island picks the look F6 renders, at every place a seeded section stands', () => {
    const places: [string, string, unknown, boolean][] = [
      ['hero', 'home', undefined, true],
      ['hero', 'contact', undefined, true],
      ['hero', 'contact', undefined, false],
      ['hero', 'services', undefined, true],
      ['hero', 'join', undefined, true],
      ['servicesOverview', 'home', undefined, true],
      ['servicesOverview', 'services', undefined, true],
      ['social', 'home', undefined, true],
      ['social', 'about', 'klein', true],
      ['statistics', 'home', 'band', true],
      ['statistics', 'about', 'reach', true],
      ['statistics', 'services', 'services', true],
      ['statistics', 'home', undefined, true],
      ['cta', 'portfolio', undefined, true],
    ];
    for (const [type, page, variant, firstOfType] of places) {
      const content = sectionStateFromObject(variant ? { variant } : {}, type);
      const picked = builtInFor(looks, { type, page, firstOfType, content });
      const f6 = builtInContent(type as (typeof RENDERED_SECTION_TYPES)[number], {
        page,
        variant,
        firstOfType,
      });
      expect(picked, `${type} ${page} ${String(variant)}`).toEqual(f6);
    }
  });

  it('follows the variant the form holds now, and none for a type with no words', () => {
    const band = sectionStateFromObject({ variant: 'band' }, 'statistics');
    expect(variantOf(band)).toBe('band');
    expect(variantOf(sectionStateFromObject({}, 'statistics'))).toBeUndefined();
    expect(variantOf({ values: { variant: 'band' }, json: '{}' })).toBeUndefined();
    expect(
      builtInFor(looks, { type: 'statistics', page: 'home', firstOfType: true, content: band })?.[
        'heading'
      ],
    ).toEqual({ en: 'The work, counted', ar: 'الشغل بالأرقام' });
    expect(
      builtInFor(looks, { type: 'team', page: 'about', firstOfType: true, content: undefined }),
    ).toBeUndefined();
    expect(
      builtInFor({}, { type: 'cta', page: 'home', firstOfType: true, content: undefined }),
    ).toBeUndefined();
  });
});

describe('the forms', () => {
  it('a section form carries its type, unseen, and its content; the sample flag only on a sample', () => {
    expect(sectionFormFields(false)).toEqual([SECTION_TYPE_FIELD, SECTION_CONTENT_FIELD]);
    expect(sectionFormFields(true).map((f) => f.name)).toEqual([
      'type',
      'content',
      'isPlaceholder',
    ]);
    expect(SECTION_TYPE_FIELD.options?.map((o) => o.value)).toEqual([...SECTION_TYPES]);
    expect(SECTION_CONTENT_FIELD).toMatchObject({ kind: 'sectionContent', typeField: 'type' });
  });

  it('the page details are the legacy page form less the fixed address', () => {
    expect(PAGE_FIELDS.map((f) => f.name)).toEqual(['title', 'status', 'scheduledFor']);
    expect(PAGE_FIELDS).toEqual(pagesUi.fields.filter((f) => f.name !== 'slug'));
  });
});

describe('the sections column', () => {
  it('reads a list row, and leaves out one it cannot', () => {
    expect(
      sectionRowOf({
        id: 'a',
        type: 'hero',
        label: ' ',
        visible: false,
        sort_order: 20,
        version: 3,
        is_placeholder: true,
      }),
    ).toEqual({
      id: 'a',
      type: 'hero',
      label: null,
      visible: false,
      sortOrder: 20,
      version: 3,
      placeholder: true,
    });
    expect(sectionRowOf({ id: 'a', type: 'hero', label: 'Top', draft: null })).toMatchObject({
      label: 'Top',
      draft: null,
    });
    expect(sectionRowOf({ type: 'hero' })).toBeNull();
  });

  it('orders by the stored number, then the id; knows the first of a type (hidden ones count)', () => {
    const rows = [
      row({ id: 'c', type: 'hero', sortOrder: 30 }),
      row({ id: 'b', type: 'hero', sortOrder: 10, visible: false }),
      row({ id: 'a', type: 'cta', sortOrder: 10 }),
    ];
    expect(inOrder(rows).map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(isFirstOfType(rows, 'b')).toBe(true);
    expect(isFirstOfType(rows, 'c')).toBe(false);
    expect(isFirstOfType(rows, 'a')).toBe(true);
  });

  it('a new section is hidden, at the end, stores nothing, and is what the route accepts', () => {
    const page = '0f0f0f0f-0000-4000-8000-00000000000a';
    const payload = newSectionPayload(page, 'cta', [
      row({ id: 'a', sortOrder: 10 }),
      row({ id: 'b', sortOrder: 40 }),
    ]);
    expect(payload).toEqual({
      pageId: page,
      type: 'cta',
      content: {},
      visible: false,
      sortOrder: 50,
      isPlaceholder: false,
    });
    expect(SectionWriteSchema.safeParse(payload).success).toBe(true);
    expect(newSectionPayload(page, 'hero', [])['sortOrder']).toBe(10);
  });

  it('after a removal opens the one after it, else the one before', () => {
    const rows = [row({ id: 'a', sortOrder: 10 }), row({ id: 'b', sortOrder: 20 })];
    expect(neighbourAfterRemoval(rows, 'a')).toBe('b');
    expect(neighbourAfterRemoval(rows, 'b')).toBe('a');
    expect(neighbourAfterRemoval([rows[0]!], 'a')).toBeNull();
  });

  it('knows a list read through the release', () => {
    expect(readsThroughRelease({ rows: [], total: 0 })).toBe(false);
    expect(readsThroughRelease({ rows: [], draftsInvalid: [] })).toBe(true);
    expect(readsThroughRelease({ rows: [{ id: 'a', draft: null }] })).toBe(true);
  });
});

describe('the open form follows a write the column made to the same section', () => {
  it('takes the whole row when it has nothing unsaved', () => {
    expect(formSyncAfterWrite({ mode: 'live', dirty: false, fullRow: true })).toBe('adopt-row');
    expect(formSyncAfterWrite({ mode: 'draft', dirty: false, fullRow: true })).toBe('adopt-row');
  });

  it('live: takes only the next version, so a colleague’s save between still stops it', () => {
    expect(formSyncAfterWrite({ mode: 'live', dirty: true, fullRow: true })).toBe('adopt-version');
    expect(formSyncAfterWrite({ mode: 'live', dirty: false, fullRow: false })).toBe(
      'adopt-version',
    );
  });

  it('releases on: reads the row again, or keeps unsaved edits for their own conflict', () => {
    expect(formSyncAfterWrite({ mode: 'draft', dirty: false, fullRow: false })).toBe('reload');
    expect(formSyncAfterWrite({ mode: 'draft', dirty: true, fullRow: true })).toBe('none');
  });
});

describe('the History drawer’s rows', () => {
  const clock = clockFor('Asia/Riyadh');
  const now = Date.parse('2026-10-25T12:00:00Z');

  it('a save: its number, the version that published it, who, when, live now', () => {
    const rows = historyRows(
      {
        enabled: false,
        live: true,
        restorable: false,
        pending: null,
        more: false,
        versions: [
          {
            seq: 2,
            version: 3,
            at: '2026-10-25T11:00:00Z',
            by: { id: 'u', name: 'Amal' },
            release: null,
            live: true,
          },
          {
            seq: 1,
            version: 2,
            at: '2026-10-20T09:30:00Z',
            by: null,
            release: { id: 'r', number: 7 },
            live: false,
          },
        ],
      },
      clock,
      now,
    );
    expect(rows.map((r) => [r.title, r.by, r.live])).toEqual([
      ['Save 2', 'Saved by Amal', true],
      ['Save 1, in v7', 'Saved by Someone', false],
    ]);
    expect(rows[0]!.when).toBe('1 h ago');
    expect(rows[1]!.full).toBe('20 Oct 2026, 12:30');
    expect(rows[1]!.iso).toBe('2026-10-20T09:30:00.000Z');
  });

  it('a site version: its number, a restore said so, who published it', () => {
    const rows = pageVersionRows(
      {
        enabled: true,
        restorable: true,
        more: false,
        versions: [
          {
            id: 'r2',
            number: 9,
            kind: 'rollback',
            note: 'Restored v7',
            publishedAt: '2026-10-25T10:00:00Z',
            publishedBy: { id: 'u', name: null },
          },
          {
            id: 'r1',
            number: null,
            kind: 'publish',
            note: null,
            publishedAt: null,
            publishedBy: null,
          },
        ],
      },
      clock,
      now,
    );
    expect(rows.map((r) => [r.title, r.by, r.note])).toEqual([
      ['v9, a restore', 'Published by Someone', 'Restored v7'],
      ['A version', 'Published by Someone', null],
    ]);
    expect(rows[1]!.iso).toBeNull();
  });
});
