import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SORT_ORDER_MAX as SCHEMA_SORT_ORDER_MAX, SectionWriteSchema } from '@schemas/admin';
import { SECTION_TYPES } from '@schemas/sectionTypes';
import { ROLES } from '@/lib/auth/types';
import { ROLE_CAPS } from '@/lib/authz/matrix';
import { clockFor } from '@/lib/admin/relTime';
import { sectionStateFromObject } from '@/lib/admin/formPayload';
import { pagesUi } from '@/lib/admin/ui/pages';
import { SECTION_COPY, builtInContent } from '@/lib/sections/copy';
import { RENDERED_SECTION_TYPES } from '@/lib/sections/registry';
import { isVisible, ADMIN_NAV, reachableHrefs } from '@/lib/admin/nav';
import { builtInLooks, mayOpenPages, pageEditorAccess } from '@/lib/admin/pages/editor';
import { overlayList } from '@/lib/release/overlay';
import { registryByTable } from '@/lib/release/registry';
import { refuseStagedBody, refuseStagedQuery } from '@/lib/release/releasesOff';
import {
  PAGE_FIELDS,
  SECTION_CONTENT_FIELD,
  SECTION_TYPE_FIELD,
  SORT_ORDER_MAX,
  builtInFor,
  columnAddress,
  columnWriteRef,
  columnWroteOn,
  draftStamp,
  formSyncAfterWrite,
  inOrder,
  isFirstOfType,
  neighbourAfterRemoval,
  newSectionPayload,
  readsThroughRelease,
  renameBody,
  sectionFormFields,
  sectionRowOf,
  toggleBody,
  variantOf,
  type SectionRow,
} from '@/components/admin/screens/pageEditor/model';
import {
  LEAVE_UNSAVED,
  columnWrite,
  mayLeave,
  openAdded,
  type OpenForm,
} from '@/components/admin/screens/pageEditor/flows';
import { collectionScreens } from '@/components/admin/screens/pageEditor/library';
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
      opens: collectionScreens(),
    });
    expect(pageEditorAccess('content_creator')).toEqual({
      sections: true,
      remove: false,
      publish: true,
      seo: 'view',
      visibility: false,
      opens: collectionScreens().filter(
        (href) => !['/admin/applications', '/admin/forms', '/admin/settings'].includes(href),
      ),
    });
    expect(pageEditorAccess('seo')).toMatchObject({
      sections: false,
      remove: false,
      publish: false,
      seo: 'full',
      visibility: false,
    });
  });

  it('links a row only to a screen the role opens: its menu reaches it', () => {
    // Every screen a link row names is on an Admin's menu; a Content Creator's menu has no
    // General settings, Forms or Job applications (settings.general, applications.manage),
    // which answer it 403, so those rows are named without a link.
    for (const role of ROLES) {
      const { opens } = pageEditorAccess(role);
      for (const href of collectionScreens()) {
        const reached = reachableHrefs(role).includes(href);
        expect(opens.includes(href), `${role} ${href}`).toBe(reached);
      }
    }
    expect(pageEditorAccess('admin').opens).toEqual(collectionScreens());
    expect(collectionScreens()).toEqual(
      expect.arrayContaining(['/admin/applications', '/admin/forms', '/admin/settings']),
    );
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

  it('a new section never passes the largest number a write takes (the add is not refused)', () => {
    const page = '0f0f0f0f-0000-4000-8000-00000000000a';
    expect(SORT_ORDER_MAX).toBe(SCHEMA_SORT_ORDER_MAX);
    for (const last of [9_995, SORT_ORDER_MAX]) {
      const payload = newSectionPayload(page, 'cta', [row({ id: 'a', sortOrder: last })]);
      expect(payload['sortOrder'], String(last)).toBe(SORT_ORDER_MAX);
      expect(SectionWriteSchema.safeParse(payload).success, String(last)).toBe(true);
    }
    expect(newSectionPayload(page, 'cta', [row({ id: 'a', sortOrder: 9_980 })])['sortOrder']).toBe(
      9_990,
    );
  });

  it('after a removal opens the one after it, else the one before', () => {
    const rows = [row({ id: 'a', sortOrder: 10 }), row({ id: 'b', sortOrder: 20 })];
    expect(neighbourAfterRemoval(rows, 'a')).toBe('b');
    expect(neighbourAfterRemoval(rows, 'b')).toBe('a');
    expect(neighbourAfterRemoval([rows[0]!], 'a')).toBeNull();
  });

  it('knows a list read through the release: the answer says so, never a row', () => {
    expect(readsThroughRelease({ rows: [], total: 0 })).toBe(false);
    expect(readsThroughRelease({ rows: [], draftsInvalid: [] })).toBe(true);
    expect(readsThroughRelease({ rows: [{ id: 'a', draft: null }] })).toBe(false);
  });
});

describe('the open form follows a write the column made to the same section', () => {
  it('releases off: takes only the next version, so a colleague’s save between still stops it', () => {
    expect(formSyncAfterWrite({ mode: 'live', formDraft: '', wroteOn: '' })).toBe('adopt-version');
  });

  it('releases on: reads the row again over what was typed, when the write named the form’s change', () => {
    expect(formSyncAfterWrite({ mode: 'draft', formDraft: 'd1:3', wroteOn: 'd1:3' })).toBe(
      'rebase',
    );
    // Nothing pending on either side: the write made the change the form now reads.
    expect(formSyncAfterWrite({ mode: 'draft', formDraft: '', wroteOn: '' })).toBe('rebase');
  });

  it('releases on: another state of the change in between leaves the form to its conflict', () => {
    expect(formSyncAfterWrite({ mode: 'draft', formDraft: 'd1:3', wroteOn: 'd1:4' })).toBe('none');
    expect(formSyncAfterWrite({ mode: 'draft', formDraft: '', wroteOn: 'd1:1' })).toBe('none');
    expect(formSyncAfterWrite({ mode: 'draft', formDraft: 'd1:1', wroteOn: '' })).toBe('none');
  });

  it('a pending change is compared by its id and its version', () => {
    expect(draftStamp(null)).toBe('');
    expect(draftStamp(undefined)).toBe('');
    expect(draftStamp({ id: 'd1', version: 2 })).toBe('d1:2');
  });
});

describe('what a write from the column sends beside its values', () => {
  const PAGE = '0f0f0f0f-0000-4000-8000-00000000000b';
  const SECTION = '11111111-1111-4111-8111-111111111111';
  const live = {
    rows: [
      {
        id: SECTION,
        page_id: PAGE,
        type: 'cta',
        label: null,
        visible: false,
        sort_order: 10,
        is_placeholder: false,
        version: 3,
        updated_at: '2026-10-27T09:00:00Z',
      },
    ],
    total: 1,
  };
  const entry = registryByTable('page_sections')!;

  /** The list answer as the route gives it, releases on (R3a's stagedList over overlayList). */
  function releaseAnswer(): Record<string, unknown> {
    const out = overlayList(
      live,
      [],
      { filters: { page_id: PAGE }, orderBy: { column: 'sort_order' } } as Parameters<
        typeof overlayList
      >[2],
      entry,
    );
    return { rows: out.rows, total: out.total, limit: 100, offset: 0, draftsInvalid: out.invalid };
  }
  const rowsOf = (answer: Record<string, unknown>) =>
    (answer['rows'] as Record<string, unknown>[]).map((raw) => sectionRowOf(raw)!);

  it('releases on, nothing pending: the row has no draft key, yet every write is marked', () => {
    const answer = releaseAnswer();
    const release = readsThroughRelease(answer);
    expect(release).toBe(true);
    const [section] = rowsOf(answer);
    // The route's own shape: a row with nothing pending carries no `draft` key at all.
    expect('draft' in (answer['rows'] as Record<string, unknown>[])[0]!).toBe(false);
    expect('draft' in section!).toBe(false);
    const toggle = toggleBody(section!, release);
    const rename = renameBody(section!, 'Closing band', release);
    expect(toggle).toEqual({ visible: true, version: 3, staged: true });
    expect(rename).toEqual({ label: 'Closing band', version: 3, staged: true });
    // Once releases are off under the screen, the live PATCH refuses both (R12's 409).
    expect(() => refuseStagedBody(toggle, 'page_section')).toThrow();
    expect(() => refuseStagedBody(rename, 'page_section')).toThrow();
    // The create, the move and the removal say so in their address (R12, R12b).
    for (const path of [
      '/api/admin/sections',
      '/api/admin/sections/reorder',
      `/api/admin/sections/${SECTION}`,
    ]) {
      const url = new URL(columnAddress(path, release), 'https://admin.test');
      expect(url.pathname, path).toBe(path);
      expect(() => refuseStagedQuery(url, 'page_section'), path).toThrow();
    }
  });

  it('releases off: the requests main sends, which the live routes take', () => {
    const answer = { rows: live.rows, total: 1, limit: 100, offset: 0 };
    const release = readsThroughRelease(answer);
    expect(release).toBe(false);
    const [section] = rowsOf(answer);
    expect(columnWriteRef(section!, release)).toEqual({});
    expect(toggleBody(section!, release)).toEqual({ visible: true, version: 3 });
    expect(renameBody(section!, null, release)).toEqual({ label: null, version: 3 });
    expect(() => refuseStagedBody(toggleBody(section!, release), 'page_section')).not.toThrow();
    for (const path of ['/api/admin/sections', '/api/admin/sections/reorder']) {
      expect(columnAddress(path, release)).toBe(path);
    }
    expect(columnWroteOn(section!)).toBe('');
  });

  it('releases on with a pending change: names it, id and version', () => {
    const [section] = rowsOf(releaseAnswer());
    const draft = { id: 'd1', version: 4, op: 'update', fields: ['label'] };
    expect(columnWriteRef({ ...section!, draft }, true)).toEqual({
      draftId: 'd1',
      draftVersion: 4,
    });
    expect(toggleBody({ ...section!, draft }, true)).toEqual({
      visible: true,
      version: 3,
      draftId: 'd1',
      draftVersion: 4,
    });
    expect(columnWroteOn({ ...section!, draft })).toBe('d1:4');
  });
});

describe('the editor’s steps: leaving the open form, a refused column write, a new section', () => {
  const form = (patch: Partial<OpenForm>): OpenForm & { flushed: number } => {
    const state = { flushed: 0 };
    return Object.assign(state, {
      mode: 'live' as const,
      dirty: false,
      flush: () => {
        state.flushed += 1;
      },
      ...patch,
    });
  };
  const never = async () => {
    throw new Error('asked');
  };

  it('a draft-mode form is saved on the way out; a clean one is left; a dirty live one asks', async () => {
    const draft = form({ mode: 'draft', dirty: true });
    expect(await mayLeave(draft, never)).toBe(true);
    expect(draft.flushed).toBe(1);
    expect(await mayLeave(form({ dirty: false }), never)).toBe(true);
    expect(await mayLeave(null, never)).toBe(true);
    const asked: unknown[] = [];
    const stay = await mayLeave(form({ dirty: true }), async (q) => {
      asked.push(q);
      return false;
    });
    expect(stay).toBe(false);
    expect(asked).toEqual([LEAVE_UNSAVED]);
    expect(await mayLeave(form({ dirty: true }), async () => true)).toBe(true);
  });

  it('Add section opens the new one only once the open form may be left', async () => {
    const opened: string[] = [];
    const open = (id: string) => opened.push(id);
    // "Stay": the open section keeps its unsaved words; the new one stays listed.
    expect(await openAdded({ id: 'new' }, async () => false, open)).toBe(false);
    expect(opened).toEqual([]);
    expect(await openAdded({ id: 'new' }, async () => true, open)).toBe(true);
    expect(opened).toEqual(['new']);
    // No id in the answer: nothing to open, nothing asked.
    expect(await openAdded({}, never, open)).toBe(false);
    // And through mayLeave, as the editor wires it: a dirty live form asks first.
    let asked = 0;
    const leave = () =>
      mayLeave(form({ dirty: true }), async () => {
        asked += 1;
        return false;
      });
    expect(await openAdded({ id: 'next' }, leave, open)).toBe(false);
    expect(asked).toBe(1);
    expect(opened).toEqual(['new']);
  });

  /** The column's io as the editor has it: a successful reread clears the error. */
  function columnIo() {
    const state = { error: '', loads: 0 };
    return Object.assign(state, {
      load: async () => {
        state.loads += 1;
        state.error = '';
      },
      setError: (words: string) => {
        state.error = words;
      },
      describe: (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong.'),
    });
  }

  it('a refused eye or move keeps its reason on screen after the list is read again', async () => {
    for (const reload of ['on-refusal', 'always'] as const) {
      const io = columnIo();
      let undone = 0;
      const ok = await columnWrite(
        async () => {
          throw new Error('Someone else saved changes while you were editing.');
        },
        io,
        { refusal: 'Not changed.', reload, undo: () => (undone += 1) },
      );
      expect(ok, reload).toBe(false);
      expect(io.loads, reload).toBe(1);
      expect(undone, reload).toBe(1);
      expect(io.error, reload).toBe(
        'Not changed. Someone else saved changes while you were editing.',
      );
    }
  });

  it('a write that goes through: read again only for a move, and no error', async () => {
    const eye = columnIo();
    expect(await columnWrite(async () => {}, eye, { refusal: 'x', reload: 'on-refusal' })).toBe(
      true,
    );
    expect(eye.loads).toBe(0);
    const move = columnIo();
    move.error = 'An earlier refusal.';
    expect(await columnWrite(async () => {}, move, { refusal: 'x', reload: 'always' })).toBe(true);
    expect(move.loads).toBe(1);
    expect(move.error).toBe('');
  });

  it('the editor sends every column write through these steps (e2e pages.e2e.ts drives them)', () => {
    const editor = readFileSync('src/components/admin/screens/pageEditor/PageEditor.tsx', 'utf8');
    // The screen's mode, from its list answer, decides every write's marker.
    expect(editor).toContain('setRelease(readsThroughRelease(answer));');
    expect(editor).toContain('body: toggleBody(row, release),');
    expect(editor).toContain('body: renameBody(row, label, release),');
    expect(editor).toContain("columnAddress('/api/admin/sections', release)");
    expect(editor).toContain("columnAddress('/api/admin/sections/reorder', release)");
    expect(editor).toContain('columnAddress(`/api/admin/sections/${row.id}`, release)');
    expect(editor).not.toContain('columnWriteRef(');
    // A refused eye or move: columnWrite; Add section and a switch: mayLeave.
    expect(editor.match(/await columnWrite\(/g)).toHaveLength(2);
    expect(editor).toContain('await openAdded(created, leaveOpen, setSelected);');
    expect(editor).toContain('const leaveOpen = () => mayLeave(form.current, confirmDialog);');
    expect(editor).not.toMatch(/setSelected\(created/);
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
