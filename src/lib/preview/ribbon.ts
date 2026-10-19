import type { VisibilityGate } from '@/lib/http/visibility';
import { toPreviewPath } from '@/lib/admin/preview/paths';
import { notPreviewedKey, PREVIEW_COPY, type PreviewVerdict } from './report';

// The preview's ribbon (Admin v2 R9; README "Preview": a fail-closed ribbon). Server-rendered
// by the middleware AFTER the page has rendered, because only then is the render's report
// final (a section component that reads late still counts): src/lib/preview/handler.ts
// builds it from the verdict and splices it in right after `<body>`, with preview.css.
//
// Every text is fixed copy (PREVIEW_COPY, P-12) or a count; every href is a path the route
// map produced. All of it is escaped anyway. The ribbon is English and left to right on
// both languages' pages (the admin's language), with `lang`/`dir` saying so.

export type RibbonVerdict = PreviewVerdict | { state: 'locked' };

export interface RibbonInput {
  verdict: RibbonVerdict;
  /** The page's live visibility, as the edge decides it for visitors. */
  gate: VisibilityGate;
  /** This preview's own URL path and query (the Reload link). */
  self: string;
  /** The public path of the page's twin in the other language. */
  twin: string;
  /** The twin's language. */
  twinLocale: 'en' | 'ar';
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

/** `{n}` → the count. */
const count = (copy: { one: string; other: string }, n: number): string =>
  n === 1 ? copy.one : copy.other.replace('{n}', String(n));

/** What visitors get for this page right now, in one line (null: an ordinary public page). */
export const VISIBILITY_COPY = {
  hide: "Visitors can't open this page right now: it is hidden on the Page visibility screen.",
  noindex: "Only people with the link can open this page, and search engines don't list it.",
  password:
    "Visitors see this password prompt. The page behind it isn't previewed while it is locked.",
} as const;

/** The ribbon's lines: the headline first, then the notes, in order. */
export function ribbonLines(input: Pick<RibbonInput, 'verdict' | 'gate'>): {
  lead: string;
  notes: string[];
} {
  const { verdict, gate } = input;
  const notes: string[] = [];
  let lead: string;
  if (verdict.state === 'untrusted') {
    lead = PREVIEW_COPY.untrusted;
    for (const reason of verdict.reasons) notes.push(PREVIEW_COPY.reasons[reason]);
  } else if (verdict.state === 'locked') {
    lead = PREVIEW_COPY.locked;
  } else {
    lead =
      verdict.pending === 0
        ? PREVIEW_COPY.ok.none
        : verdict.pending === 1
          ? PREVIEW_COPY.ok.one
          : PREVIEW_COPY.ok.other.replace('{n}', String(verdict.pending));
    if (verdict.invalid.length > 0) notes.push(count(PREVIEW_COPY.invalid, verdict.invalid.length));
    if (verdict.samples > 0) notes.push(count(PREVIEW_COPY.samples, verdict.samples));
    const keys = [...new Set(verdict.notPreviewed.map(notPreviewedKey))];
    for (const key of keys) notes.push(PREVIEW_COPY.notPreviewed[key]);
  }
  if (gate.action === 'hide') notes.push(VISIBILITY_COPY.hide);
  if (gate.action === 'noindex') notes.push(VISIBILITY_COPY.noindex);
  if (gate.action === 'password') notes.push(VISIBILITY_COPY.password);
  return { lead, notes };
}

/** The ribbon's markup. */
export function renderRibbon(input: RibbonInput): string {
  const { lead, notes } = ribbonLines(input);
  const twinHref = toPreviewPath(input.twin);
  const twinLabel = input.twinLocale === 'ar' ? 'العربية' : 'English';
  const twinAttrs = input.twinLocale === 'ar' ? ' lang="ar" dir="rtl"' : ' lang="en" dir="ltr"';
  const links = [
    `<a href="/admin">Back to the admin</a>`,
    twinHref
      ? `<a href="${escapeHtml(twinHref)}"${twinAttrs}>${escapeHtml(twinLabel)}</a>`
      : '',
    input.verdict.state === 'untrusted'
      ? `<a href="${escapeHtml(input.self)}">Reload the preview</a>`
      : '',
  ].filter(Boolean);
  return (
    `<aside class="pv-ribbon" data-pv-ribbon data-state="${escapeHtml(input.verdict.state)}"` +
    ` aria-label="Preview status" lang="en" dir="ltr">` +
    `<p class="pv-ribbon__lead"><span class="pv-ribbon__dot" aria-hidden="true"></span>` +
    `${escapeHtml(lead)}</p>` +
    (notes.length > 0
      ? `<ul class="pv-ribbon__notes">${notes.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>`
      : '') +
    `<p class="pv-ribbon__links">${links.join(' ')}</p>` +
    `</aside>`
  );
}

/** The preview's stylesheet, same-origin (style-src 'self'). */
export const PREVIEW_STYLESHEET = '<link rel="stylesheet" href="/styles/preview.css" />';

/**
 * Splices the ribbon in after the first `<body…>` tag and the stylesheet before `</head>`.
 * A document without either gets the piece at its start: the ribbon is never dropped.
 */
export function injectRibbon(html: string, ribbon: string): string {
  let out = html;
  const head = /<\/head\s*>/i.exec(out);
  out = head
    ? `${out.slice(0, head.index)}${PREVIEW_STYLESHEET}${out.slice(head.index)}`
    : `${PREVIEW_STYLESHEET}${out}`;
  const body = /<body\b[^>]*>/i.exec(out);
  return body
    ? `${out.slice(0, body.index + body[0].length)}${ribbon}${out.slice(body.index + body[0].length)}`
    : `${ribbon}${out}`;
}
