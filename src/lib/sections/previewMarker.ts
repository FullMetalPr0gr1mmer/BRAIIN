// The releases preview's section marker (Admin v2 R9, P-4: `data-pv-section`). The page
// editor's bridge finds a section by it (jump, highlight). It goes on the section's own
// first element rather than on a wrapper, so a preview lays out exactly as the public page
// does (no extra box between a section and the selectors that style it), and only a preview
// render calls this (SectionBoundary, given a `previewId`).

/** What a marker may hold: a section's uuid or `default-<n>`; nothing to escape. */
const ID = /^[A-Za-z0-9-]{1,64}$/;

/** The first element that is part of the section's layout (not a script, style or link). */
const FIRST_ELEMENT = /<(?!(?:script|style|link|template|meta)\b)([a-zA-Z][\w-]*)\b/;

/**
 * Adds ` data-pv-section="<id>"` to the first element of a section's rendered HTML. An id
 * that is not a plain token, or markup with no element, is left as it is.
 */
export function markPreviewSection(html: string, id: string): string {
  if (!ID.test(id)) return html;
  const m = FIRST_ELEMENT.exec(html);
  if (!m) return html;
  const at = m.index + m[0].length;
  return `${html.slice(0, at)} data-pv-section="${id}"${html.slice(at)}`;
}
