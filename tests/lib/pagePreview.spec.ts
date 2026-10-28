import { describe, expect, it } from 'vitest';
import { ToPreviewMessageSchema } from '@schemas/previewMessage';
import {
  DEVICE_OPTIONS,
  DEVICE_WIDTH,
  FRAME_GUTTER,
  fitFrame,
  followUp,
  localePath,
  mayOpen,
  missingNote,
  pathnameOf,
  previewSrc,
  showsPage,
} from '@/components/admin/screens/pagePreview/model';
import {
  NO_PREVIEW,
  PREVIEW_HEADING,
  PREVIEW_LOADING,
  VIEW_OPTIONS,
  previewLangAfter,
  previewLead,
} from '@/components/admin/screens/pagePreview/editorSide';
import { pageMoved, rowMoved, type SectionRow } from '@/components/admin/screens/pageEditor/model';
import { fromPreviewPath } from '@/lib/admin/preview/paths';
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
    expect(localePath('/contact', 'ar')).toBe('/ar/contact');
  });

  it('exists for every page an address of the site shows, and maps back to that address', () => {
    for (const path of Object.values(PAGE_PATHS)) {
      for (const lang of ['en', 'ar'] as const) {
        const src = previewSrc(path, lang);
        expect(src, `${path} ${lang}`).not.toBeNull();
        expect(fromPreviewPath(src!)).toBe(localePath(path, lang));
      }
    }
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

  it('the page’s own row, after its first read', () => {
    expect(pageMoved(null, { version: 2 })).toBe(false);
    expect(pageMoved('2:', { version: 2 })).toBe(false);
    expect(pageMoved('2:', { version: 3 })).toBe(true);
    expect(pageMoved('2:', { version: 2, draft: { id: OTHER, version: 1, op: 'update' } })).toBe(
      true,
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
