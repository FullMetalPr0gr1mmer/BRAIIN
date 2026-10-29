// What the page editor needs of the live preview before the column itself loads (Admin v2 E2,
// docs/admin-v2/ui.md "Preview column"): the column's heading and lead, the narrow screens'
// Edit | Preview switch, and how the preview's language follows the editor's. Pure, imported by
// the editor (admin-pages); the column's own code (PreviewColumn.tsx, model.ts) is the lazy
// `admin-page-preview` chunk, loaded only once the preview is on screen, and nothing here
// imports it. P-12: plain, warm, no em or en dashes.

export type PreviewLang = 'en' | 'ar';

/** The preview's language after the editor's changed: Both keeps the one shown. */
export function previewLangAfter(editor: 'en' | 'ar' | 'both', current: PreviewLang): PreviewLang {
  return editor === 'both' ? current : editor;
}

export const PREVIEW_HEADING = 'Live preview';

/**
 * What the preview shows and when it changes, honest per mode: with releases on an edit is a
 * pending change the preview lays over the site (ui.md's words); with them off each save is
 * live, and the preview is the page as visitors see it.
 */
export function previewLead(release: boolean): string {
  return release
    ? 'Your edits are saved as drafts. Nothing changes on the site until you publish.'
    : 'This is the page as visitors see it. Each save changes the site, and the preview reloads after it.';
}

export const NO_PREVIEW =
  'No address of the site shows this page yet, so there is nothing to preview.';

/** A page with an address the preview does not render (none today: editor.ts previewable). */
export const NOT_PREVIEWED =
  'The preview cannot show this page yet. Open page shows it on the site.';

export const PREVIEW_LOADING = 'Loading the preview…';

/** The narrow screens' switch between the fields and the preview (ui.md "Responsive"). */
export const VIEW_LABEL = 'Show';
export const VIEW_OPTIONS = [
  { value: 'edit', label: 'Edit' },
  { value: 'preview', label: 'Preview' },
] as const;
export type EditorView = (typeof VIEW_OPTIONS)[number]['value'];

/**
 * The view after a section picked in the preview has opened (E2 review CR5): below 1280 px
 * (`wide` false) the preview stood where the fields go, so the fields come back to edit the
 * section picked; from 1280 px, or before the width is known, the view stays as it is.
 */
export function viewAfterPreviewPick(view: EditorView, wide: boolean | null): EditorView {
  return wide === false ? 'edit' : view;
}
