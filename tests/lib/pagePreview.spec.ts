import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { ToPreviewMessageSchema } from '@schemas/previewMessage';
import {
  DEVICE_OPTIONS,
  DEVICE_WIDTH,
  FRAME_GUTTER,
  bridgeMissing,
  fitFrame,
  followUp,
  frameDebt,
  frameStep,
  mayOpen,
  missingNote,
  pathnameOf,
  previewSrc,
  reloadAct,
  showsPage,
  type FrameDebt,
  type FrameEvent,
} from '@/components/admin/screens/pagePreview/model';
import {
  NOT_PREVIEWED,
  NO_PREVIEW,
  PREVIEW_HEADING,
  PREVIEW_LOADING,
  VIEW_OPTIONS,
  previewLangAfter,
  previewLead,
  viewAfterPreviewPick,
} from '@/components/admin/screens/pagePreview/editorSide';
import {
  PREVIEW_RELOADS,
  pageMoved,
  previewSectionsOf,
  reloadsPreview,
  rowMoved,
  rowStamp,
  withRow,
  type EditorWrite,
  type SectionRow,
} from '@/components/admin/screens/pageEditor/model';
import { fromPreviewPath } from '@/lib/admin/preview/paths';
import { previewable } from '@/lib/admin/pages/editor';
import {
  announceDiscarded,
  announceSettled,
  onDraftsMoved,
  SETTLED_EVENT,
} from '@/lib/admin/releaseEvents';
import { localizedPath } from '@/lib/i18n';
import { PAGE_PATHS } from '@/lib/visibility/routes';

// The page editor's live preview column (Admin v2 E2, docs/admin-v2/ui.md "Preview column
// (AV-26)"): its pure rules. The browser half (the frame, the bridge, the scale) is
// tests/admin/page-preview.e2e.ts's.

const ID = '5eed5000-0000-4000-8000-000000000001';
const OTHER = '5eed5000-0000-4000-8000-000000000002';

describe('the frame’s address', () => {
  it('is R9’s preview route for the page’s path, in English or Arabic', () => {
    expect(previewSrc('/about', 'en')).toBe('/admin/preview/about');
    expect(previewSrc('/about', 'ar')).toBe('/admin/preview/ar/about');
    expect(previewSrc('/', 'en')).toBe('/admin/preview');
    expect(previewSrc('/', 'ar')).toBe('/admin/preview/ar');
    expect(previewSrc(null, 'en')).toBeNull();
    expect(previewSrc('/contact', 'ar')).toBe('/admin/preview/ar/contact');
  });

  it('exists for every page an address of the site shows, and maps back to that address', () => {
    for (const path of Object.values(PAGE_PATHS)) {
      for (const lang of ['en', 'ar'] as const) {
        const src = previewSrc(path, lang);
        expect(src, `${path} ${lang}`).not.toBeNull();
        expect(fromPreviewPath(src!)).toBe(localizedPath(path, lang));
      }
    }
  });

  it('is offered only for a path the preview renders in both languages (E2 review CR6)', () => {
    for (const path of Object.values(PAGE_PATHS)) expect(previewable(path), path).toBe(true);
    expect(previewable(null)).toBe(false);
    // An address R9's map does not render: the column would wait for a frame forever.
    expect(previewSrc('/rss.xml', 'en')).toBeNull();
    expect(previewable('/rss.xml')).toBe(false);
  });

  it('reuses the site’s own localizedPath, no copy of it (E2 review CR7)', () => {
    const model = readFileSync('src/components/admin/screens/pagePreview/model.ts', 'utf8');
    expect(model).toContain('toPreviewPath(localizedPath(path, lang))');
    expect(model).not.toMatch(/`\/ar\$\{/);
    const editor = readFileSync('src/components/admin/screens/pageEditor/PageEditor.tsx', 'utf8');
    expect(editor).toContain("href={localizedPath(page.path, 'ar')}");
    expect(editor).not.toMatch(/`\/ar\$\{/);
  });

  it('follows the editor’s language; Both keeps the one shown', () => {
    expect(previewLangAfter('ar', 'en')).toBe('ar');
    expect(previewLangAfter('en', 'ar')).toBe('en');
    expect(previewLangAfter('both', 'ar')).toBe('ar');
    expect(previewLangAfter('both', 'en')).toBe('en');
  });

  it('tells the editor’s page from a page a link led to', () => {
    expect(pathnameOf('/admin/preview/about?only=a#x')).toBe('/admin/preview/about');
    expect(showsPage('/admin/preview/about/', '/admin/preview/about')).toBe(true);
    expect(showsPage('/admin/preview/about?v=3', '/admin/preview/about')).toBe(true);
    expect(showsPage('/admin/preview/contact', '/admin/preview/about')).toBe(false);
    expect(showsPage('/admin/preview/ar/about', '/admin/preview/about')).toBe(false);
  });
});

describe('the device widths and the scale', () => {
  it('renders at 1280, 834 and 390 (ui.md), named Desktop, Tablet and Phone', () => {
    expect(DEVICE_WIDTH).toEqual({ desktop: 1280, tablet: 834, phone: 390 });
    expect(DEVICE_OPTIONS.map((o) => o.label)).toEqual(['Desktop', 'Tablet', 'Phone']);
  });

  it('scales a page down to the column, never up, and fills the height at that scale', () => {
    const area = { width: 400 + 2 * FRAME_GUTTER, height: 600 + 2 * FRAME_GUTTER };
    const desktop = fitFrame(area, 'desktop');
    expect(desktop.scale).toBeCloseTo(400 / 1280);
    expect(desktop.frameWidth).toBe(1280);
    expect(desktop.boxWidth).toBe(400);
    expect(desktop.boxHeight).toBe(600);
    expect(desktop.frameHeight).toBe(Math.ceil(600 / (400 / 1280)));
    const phone = fitFrame({ width: 900, height: 700 }, 'phone');
    expect(phone.scale).toBe(1);
    expect(phone.boxWidth).toBe(390);
    expect(phone.frameHeight).toBe(700 - 2 * FRAME_GUTTER);
  });

  it('never divides by zero in a column not laid out yet', () => {
    const fit = fitFrame({ width: 0, height: 0 }, 'tablet');
    expect(Number.isFinite(fit.scale)).toBe(true);
    expect(fit.scale).toBeGreaterThan(0);
    expect(Number.isFinite(fit.frameHeight)).toBe(true);
  });
});

describe('following the editor', () => {
  it('jumps to the open section and outlines it when the preview shows it', () => {
    const sent = followUp([OTHER, ID], ID, true);
    expect(sent).toEqual([
      { v: 1, type: 'jump', sectionId: ID },
      { v: 1, type: 'highlight', sectionId: ID },
    ]);
    for (const message of sent)
      expect(ToPreviewMessageSchema.safeParse(message).success).toBe(true);
  });

  it('takes the outline away for a section it does not show, or on another page', () => {
    const none = [{ v: 1, type: 'highlight', sectionId: null }];
    expect(followUp([OTHER], ID, true)).toEqual(none);
    expect(followUp([ID], ID, false)).toEqual(none);
    expect(followUp([ID], 'page', true)).toEqual(none);
    expect(ToPreviewMessageSchema.safeParse(none[0]).success).toBe(true);
  });

  it('opens a section clicked in the preview only when the editor lists it, on its page', () => {
    expect(mayOpen(ID, [ID, OTHER], OTHER, true)).toBe(true);
    // Already open, not listed (a built-in section, another page's), or another page shown.
    expect(mayOpen(ID, [ID], ID, true)).toBe(false);
    expect(mayOpen('default-0', [ID], OTHER, true)).toBe(false);
    expect(mayOpen(ID, [OTHER], OTHER, true)).toBe(false);
    expect(mayOpen(ID, [ID, OTHER], OTHER, false)).toBe(false);
  });

  it('says why the open section is not in the preview', () => {
    expect(missingNote({ name: 'Leadership', visible: false }, [OTHER], ID)).toBe(
      'Leadership is hidden, so the preview does not show it.',
    );
    expect(missingNote({ name: 'Numbers', visible: true }, [OTHER], ID)).toBe(
      'Numbers does not show on this page, so the preview cannot point at it.',
    );
    expect(missingNote({ name: 'Numbers', visible: true }, [ID], ID)).toBeNull();
    expect(missingNote(null, [], 'page')).toBeNull();
  });
});

describe('a save, not a read, reloads the preview', () => {
  const row = (patch: Partial<SectionRow> = {}): SectionRow => ({
    id: ID,
    type: 'cta',
    label: null,
    visible: true,
    sortOrder: 10,
    version: 3,
    placeholder: false,
    ...patch,
  });

  it('a section row whose version or pending change moved', () => {
    expect(rowMoved(row(), row({ version: 4 }))).toBe(true);
    expect(
      rowMoved(
        row({ draft: { id: OTHER, version: 1, op: 'update' } }),
        row({ draft: { id: OTHER, version: 2, op: 'update' } }),
      ),
    ).toBe(true);
    // The form's first read, or a rebase after the column's own write: the same version.
    expect(rowMoved(row(), row())).toBe(false);
    expect(
      rowMoved(
        row({ draft: { id: OTHER, version: 2, op: 'update' } }),
        row({ draft: { id: OTHER, version: 2, op: 'update' } }),
      ),
    ).toBe(false);
    // A row the list does not hold yet.
    expect(rowMoved(undefined, row())).toBe(false);
  });

  it('a pending change the row read no longer names is a move (E2 review CR1)', () => {
    const pending = row({ draft: { id: OTHER, version: 2, op: 'update' } });
    // Thrown away or published: the row comes back without it, at the same live version.
    expect(rowMoved(pending, row())).toBe(true);
    expect(rowMoved(pending, row({ draft: null }))).toBe(true);
    // The list takes the row as answered: the old pending change does not stay on it.
    const listed = withRow([pending, row({ id: OTHER })], row());
    expect(listed[0]).toEqual(row());
    expect('draft' in listed[0]!).toBe(false);
    expect(listed[1]).toEqual(row({ id: OTHER }));
    const removal = row({ pendingRemoval: true, draft: { id: OTHER, version: 1, op: 'delete' } });
    expect(withRow([removal], row())[0]!.pendingRemoval).toBeUndefined();
  });

  it('a section row and a server row are stamped alike (E2 review CR9)', () => {
    expect(rowStamp(row())).toBe('3:');
    expect(rowStamp({ version: 3, draft: { id: OTHER, version: 2, op: 'update' } })).toBe('3:2');
  });

  it('the page’s own row, after its first read', () => {
    expect(pageMoved(null, { version: 2 })).toBe(false);
    expect(pageMoved('2:', { version: 2 })).toBe(false);
    expect(pageMoved('2:', { version: 3 })).toBe(true);
    expect(pageMoved('2:', { version: 2, draft: { id: OTHER, version: 1, op: 'update' } })).toBe(
      true,
    );
  });
});

describe('a hidden column owes, and pays once it is shown (P-15)', () => {
  const EN = '/admin/preview/about';
  const AR = '/admin/preview/ar/about';
  /** Runs events in order, each with whether the column is laid out; the acts and the debt. */
  function run(start: FrameDebt, events: [FrameEvent, boolean][]) {
    let debt = start;
    const acts: string[] = [];
    for (const [event, shown] of events) {
      const next = frameStep(debt, event, shown);
      debt = next.debt;
      if (next.act) acts.push(next.act);
    }
    return { debt, acts };
  }
  const ready = (): FrameDebt => ({ src: EN, want: EN, reload: false, jump: false });

  it('gives the first address only once the column is shown', () => {
    const hidden = run(frameDebt(EN), [[{ type: 'shown' }, false]]);
    expect(hidden.debt.src).toBe('');
    const shown = run(frameDebt(EN), [[{ type: 'shown' }, true]]);
    expect(shown.debt.src).toBe(EN);
    expect(shown.acts).toEqual([]);
  });

  it('shown: a save reloads, a new section is followed, a language swaps the address', () => {
    expect(run(ready(), [[{ type: 'saved' }, true]]).acts).toEqual(['reload']);
    expect(run(ready(), [[{ type: 'follow' }, true]]).acts).toEqual(['follow']);
    const swapped = run(ready(), [[{ type: 'address', src: AR }, true]]);
    expect(swapped.debt).toEqual({ src: AR, want: AR, reload: false, jump: false });
    expect(swapped.acts).toEqual([]);
  });

  it('a section opened while hidden is jumped to once the column is shown (E2-C1)', () => {
    const hidden = run(ready(), [[{ type: 'follow' }, false]]);
    expect(hidden.acts).toEqual([]);
    expect(hidden.debt.jump).toBe(true);
    const back = run(hidden.debt, [
      [{ type: 'shown' }, true],
      [{ type: 'shown' }, true], // a resize after: paid once
    ]);
    expect(back.acts).toEqual(['follow']);
    expect(back.debt.jump).toBe(false);
  });

  it('a language changed while hidden loads nothing until the column is shown (E2-C2)', () => {
    const hidden = run(ready(), [
      [{ type: 'address', src: AR }, false],
      [{ type: 'follow' }, false],
    ]);
    expect(hidden.debt.src).toBe(EN);
    expect(hidden.debt.want).toBe(AR);
    // Shown: the new address, whose `ready` is followed; nothing else is sent to the old page.
    const back = run(hidden.debt, [[{ type: 'shown' }, true]]);
    expect(back.debt).toEqual({ src: AR, want: AR, reload: false, jump: false });
    expect(back.acts).toEqual([]);
    // Away and back while hidden: the frame already shows it, nothing loads.
    const there = run(ready(), [
      [{ type: 'address', src: AR }, false],
      [{ type: 'address', src: EN }, false],
      [{ type: 'shown' }, true],
    ]);
    expect(there.debt.src).toBe(EN);
    expect(there.acts).toEqual([]);
  });

  it('a save while hidden reloads once the column is shown, and not before (E2-C7)', () => {
    const hidden = run(ready(), [
      [{ type: 'saved' }, false],
      [{ type: 'saved' }, false],
      [{ type: 'follow' }, false],
    ]);
    expect(hidden.acts).toEqual([]);
    expect(hidden.debt.reload).toBe(true);
    // One reload covers the jump (its `ready` is followed).
    expect(run(hidden.debt, [[{ type: 'shown' }, true]]).acts).toEqual(['reload']);
  });
});

describe('a frame without the bridge (E2-C3, review CR3)', () => {
  it('is said when the document shown never said `ready`, whatever the column believed', () => {
    const readied = new WeakSet<object>();
    const first = {};
    // The first page loaded, its `ready` not heard yet: missing until it is.
    expect(bridgeMissing(first, readied)).toBe(true);
    readied.add(first);
    expect(bridgeMissing(first, readied)).toBe(false);
    // A ready preview whose link led to a page without the bridge: that document said nothing.
    expect(bridgeMissing({}, readied)).toBe(true);
    // Another site's page: the column cannot read it.
    expect(bridgeMissing(null, readied)).toBe(true);
  });

  it('a `ready` heard after its frame’s load is not credited to the next page (CR3)', () => {
    // The order the counting rule got wrong: page A loads, A's `ready` lands late, then a link
    // leads to B, a page without the bridge. Each `ready` is held against its own document.
    const readied = new WeakSet<object>();
    const a = {};
    const b = {};
    readied.add(a); // A's late `ready`, heard while A is shown
    expect(bridgeMissing(a, readied)).toBe(false);
    expect(bridgeMissing(b, readied)).toBe(true);
  });

  const column = readFileSync('src/components/admin/screens/pagePreview/PreviewColumn.tsx', 'utf8');
  it('the column holds each `ready` against the document shown, and checks the one loaded', () => {
    // On `ready`: the frame's document now is the one that said it.
    expect(column).toMatch(
      /case 'ready': \{\s+const shownDocument = frameDocument\(\);\s+if \(shownDocument\) readied\.current\.add\(shownDocument\);/,
    );
    // After the frame's load and its grace: the document shown then, never a count.
    expect(column).toMatch(/bridgeMissing\(frameDocument\(\), readied\.current\)/);
    expect(column).toMatch(/onLoad=\{loaded\}/);
  });
});

describe('a save while the preview loads (E2 review CR2)', () => {
  it('waits for the page to be ready instead of tearing the frame down', () => {
    expect(reloadAct('ready', 'save')).toBe('send');
    expect(reloadAct('loading', 'save')).toBe('queue');
    expect(reloadAct('failed', 'save')).toBe('remount');
    // The person's Reload: a page that hangs, or failed, gets a new frame.
    expect(reloadAct('ready', 'person')).toBe('send');
    expect(reloadAct('loading', 'person')).toBe('remount');
    expect(reloadAct('failed', 'person')).toBe('remount');
  });

  const column = readFileSync('src/components/admin/screens/pagePreview/PreviewColumn.tsx', 'utf8');
  it('one queued reload, paid on `ready`, dropped by a new frame or address', () => {
    expect(column).toMatch(
      /const act = reloadAct\(latest\.current\.state, by\);\s+if \(act === 'queue'\) \{\s+queued\.current = true;\s+return;\s+\}/,
    );
    // On `ready`: the queued reload first (through frameStep, so a hidden column owes it).
    expect(column).toMatch(
      /if \(queued\.current\) \{\s+queued\.current = false;\s+step\(\{ type: 'saved' \}\);\s+return;\s+\}\s+step\(\{ type: 'follow' \}\);/,
    );
    // A new document is requested after every save so far.
    expect(column).toMatch(
      /setShown\(null\);\s+queued\.current = false;\s+\}, \[src, frameKey\]\);/,
    );
    // A save's reload and the person's are told apart.
    expect(column).toContain("if (next.act === 'reload') reload('save');");
    expect(column).toContain("onClick={() => reload('person')}");
  });
});

describe('which writes reload the preview (E2-C7)', () => {
  it('every write a visitor can see; not a rename, not Add section (hidden)', () => {
    expect(PREVIEW_RELOADS).toEqual({
      field: true,
      pageDetails: true,
      eye: true,
      move: true,
      add: false,
      rename: false,
      remove: true,
      restore: true,
      settled: true,
    });
    for (const kind of Object.keys(PREVIEW_RELOADS) as EditorWrite[])
      expect(reloadsPreview(kind)).toBe(PREVIEW_RELOADS[kind]);
  });

  // The editor is a React island whose handlers do not run in a server render, so its wiring
  // is read from the source (as tests/lib/releaseModeWrites.spec.ts does): each write's
  // handler reports itself, once, and nothing else moves the save signal.
  const source = readFileSync('src/components/admin/screens/pageEditor/PageEditor.tsx', 'utf8');
  /** A handler's body: from its start to the next handler or the end of its JSX prop. */
  function body(start: string, end: RegExp): string {
    const at = source.indexOf(start);
    expect(at, start).toBeGreaterThan(-1);
    const rest = source.slice(at + start.length);
    const stop = rest.search(end);
    return stop === -1 ? rest : rest.slice(0, stop);
  }
  const NEXT = /\n {2}(async )?function /;

  it('each handler reports its own write, once', () => {
    const handlers: Record<EditorWrite, string> = {
      field: body('function formRow(', NEXT),
      pageDetails: body('function pageRow(', NEXT),
      eye: body('async function toggle(', NEXT),
      move: body('async function commitOrder(', NEXT),
      add: body('async function add(', NEXT),
      rename: body('async function rename(', NEXT),
      remove: body('async function remove(', NEXT),
      restore: body('onRestored={', /\n {10}\}\}/),
      settled: body('onDraftsMoved(', /\n {4}\}\);/),
    };
    for (const [kind, handler] of Object.entries(handlers)) {
      const calls = [...handler.matchAll(/\bwrote\('(\w+)'\)/g)].map((m) => m[1]);
      expect(calls, kind).toEqual([kind]);
    }
  });

  it('the save signal moves only through `wrote`', () => {
    expect(source.match(/\bsetRevision\(/g)).toHaveLength(1);
    expect(source).toMatch(/if \(reloadsPreview\(kind\)\) setRevision\(/);
    const all = [...source.matchAll(/\bwrote\('(\w+)'\)/g)].map((m) => m[1]).sort();
    expect(all).toEqual(Object.keys(PREVIEW_RELOADS).sort());
  });
});

describe('a change settled or thrown away elsewhere (E2 review CR1)', () => {
  it('is heard from the publish dialog’s settle and from a discard, until unsubscribed', () => {
    vi.stubGlobal('window', new EventTarget());
    try {
      let heard = 0;
      const off = onDraftsMoved(() => (heard += 1));
      announceSettled('d1');
      announceDiscarded();
      // A settle event without its draft id is not R12's.
      window.dispatchEvent(new CustomEvent(SETTLED_EVENT));
      expect(heard).toBe(2);
      off();
      announceSettled('d1');
      announceDiscarded();
      expect(heard).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('the editor reads its sections again and reloads the preview, in release mode only', () => {
    const editor = readFileSync('src/components/admin/screens/pageEditor/PageEditor.tsx', 'utf8');
    expect(editor).toMatch(
      /useEffect\(\(\) => \{\s+if \(!release\) return;\s+return onDraftsMoved\(\(\) => \{\s+void load\(\);\s+wrote\('settled'\);\s+\}\);\s+\}, \[release, load, wrote\]\);/,
    );
    // A write's answer replaces its row in the list (withRow), never merges into it.
    expect(editor).toContain('setRows((current) => current && withRow(current, row));');
    expect(editor).not.toMatch(/\{ \.\.\.r, \.\.\.row \}/);
  });
});

describe('a section picked in the preview (E2 review CR5)', () => {
  it('brings the fields back below 1280 px; the three columns stay as they are', () => {
    expect(viewAfterPreviewPick('preview', false)).toBe('edit');
    expect(viewAfterPreviewPick('edit', false)).toBe('edit');
    expect(viewAfterPreviewPick('preview', true)).toBe('preview');
    expect(viewAfterPreviewPick('edit', true)).toBe('edit');
    expect(viewAfterPreviewPick('preview', null)).toBe('preview');
  });

  it('only once the section is open (unsaved work asked about first)', () => {
    const editor = readFileSync('src/components/admin/screens/pageEditor/PageEditor.tsx', 'utf8');
    expect(editor).toMatch(
      /async function openFromPreview\(id: string\) \{\s+if \(await select\(id\)\) setView\(\(current\) => viewAfterPreviewPick\(current, wide\)\);\s+\}/,
    );
    expect(editor).toContain('onSelect={(id) => void openFromPreview(id)}');
  });
});

describe('the sections the preview is told of (E2 review CR8)', () => {
  it('in the list’s order with their names, rebuilt only when the list changes', () => {
    const base = { type: 'cta', sortOrder: 1, version: 1, placeholder: false };
    const rows: SectionRow[] = [
      { ...base, id: ID, label: 'Ask', visible: false },
      { ...base, id: OTHER, label: null, visible: true, sortOrder: 2 },
    ];
    const told = previewSectionsOf(rows);
    expect(told.map((s) => s.id)).toEqual([ID, OTHER]);
    expect(told[0]).toEqual({ id: ID, name: 'Ask', visible: false });
    expect(told[1]!.name).not.toBe('');
    expect(told[1]!.visible).toBe(true);
    const editor = readFileSync('src/components/admin/screens/pageEditor/PageEditor.tsx', 'utf8');
    expect(editor).toContain(
      'const previewSections = useMemo(() => previewSectionsOf(rows ?? []), [rows]);',
    );
  });
});

describe('the words (P-12)', () => {
  it('say what the preview shows in each mode', () => {
    // ui.md's bar copy, with releases on.
    expect(previewLead(true)).toBe(
      'Your edits are saved as drafts. Nothing changes on the site until you publish.',
    );
    // With releases off a save is live: the page as visitors see it.
    expect(previewLead(false)).toContain('as visitors see it');
    expect(previewLead(false)).toContain('Each save changes the site');
  });

  it('carry no em or en dash', () => {
    const words = [
      PREVIEW_HEADING,
      PREVIEW_LOADING,
      NO_PREVIEW,
      NOT_PREVIEWED,
      previewLead(true),
      previewLead(false),
      ...VIEW_OPTIONS.map((o) => o.label),
      ...DEVICE_OPTIONS.map((o) => o.label),
      missingNote({ name: 'X', visible: false }, [], ID)!,
      missingNote({ name: 'X', visible: true }, [], ID)!,
    ];
    for (const text of words) expect(text, text).not.toMatch(/[–—]/);
  });
});
