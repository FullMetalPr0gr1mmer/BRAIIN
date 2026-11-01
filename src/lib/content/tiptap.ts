import {
  TiptapDocSchema,
  sectionDocProblem,
  type TiptapDoc,
  type TiptapMark,
  type TiptapNode,
} from '@schemas/tiptap';

// Tiptap document → sanitised HTML. CLAUDE.md Pillar 1: "Tiptap sanitised on write AND
// render; never `set:html` unsanitised."
//
// ── Why this is an allowlist RENDERER and not an HTML sanitiser ──────────────────
// The usual shape of this problem is "editor produces HTML, strip the dangerous bits
// out of it". That is a losing game: you are parsing attacker-influenced markup and
// trying to enumerate badness, and every HTML-sanitiser CVE in history is a bypass of
// exactly that enumeration.
//
// Here the stored artefact is Tiptap's JSON, not HTML, so we never parse untrusted
// markup at all. This module walks the JSON and EMITS markup for the node and mark
// types it knows about. An unknown node type does not get "cleaned" — it produces
// nothing but its (also-walked) children. There is no code path from stored content to
// an attribute or tag that is not written literally in this file.
//
// Consequences that fall out of that, all of them deliberate:
//   • no `style=` anywhere (the theme is CSS custom properties — CLAUDE.md §7)
//   • no `data:`/`blob:` URLs (dropped from img-src in the CSP for the same reason)
//   • no `class` from content; classes come from the stylesheet, keyed off tag names
//   • `javascript:` and friends cannot appear, because href goes through an
//     allowlist of SCHEMES rather than a blocklist

// ── Escaping ────────────────────────────────────────────────────────────────────

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

// ── URL policy ──────────────────────────────────────────────────────────────────

const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:']);

/**
 * Returns a safe href, or null to drop the link entirely (the text survives).
 *
 * A relative href is resolved against a throwaway base and kept only when it stays on
 * that base's origin. The base is invented, but the answer does not depend on it: a
 * same-site reference resolves onto whatever origin it is given, while scheme-relative
 * `//evil.example` and `/\evil.example` (the URL standard reads a backslash as a slash
 * in an https URL) resolve to another host from ANY base. Both look harmless precisely
 * because they are absolute cross-origin URLs wearing a relative costume.
 */
export function sanitizeHref(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const href = raw.trim();
  if (href.length === 0 || href.length > 2048) return null;
  if (href.startsWith('/') || href.startsWith('#') || href.startsWith('?')) {
    return staysOnSite(href) ? href : null;
  }
  try {
    const parsed = new URL(href);
    return ALLOWED_SCHEMES.has(parsed.protocol) ? href : null;
  } catch {
    return null;
  }
}

const SAME_SITE_BASE = 'https://same-site.invalid';

function staysOnSite(href: string): boolean {
  try {
    return new URL(href, SAME_SITE_BASE).origin === SAME_SITE_BASE;
  } catch {
    return false;
  }
}

// ── Marks ───────────────────────────────────────────────────────────────────────

const SIMPLE_MARK_TAGS: Record<string, string> = {
  bold: 'strong',
  strong: 'strong',
  italic: 'em',
  em: 'em',
  strike: 's',
  underline: 'u',
  code: 'code',
  superscript: 'sup',
  subscript: 'sub',
};

function wrapWithMarks(text: string, marks: TiptapMark[] | undefined): string {
  if (!marks || marks.length === 0) return text;
  let out = text;
  // Innermost first so the emitted nesting matches the order Tiptap stores.
  for (const mark of [...marks].reverse()) {
    const tag = SIMPLE_MARK_TAGS[mark.type];
    if (tag) {
      out = `<${tag}>${out}</${tag}>`;
      continue;
    }
    if (mark.type === 'link') {
      const href = sanitizeHref(mark.attrs?.['href']);
      if (!href) continue; // drop the link, keep the words
      // rel is fixed, never authored: `noopener` closes the reverse-tabnabbing hole and
      // `ugc` is the honest declaration for editor-authored outbound links (Pillar 3).
      out = `<a href="${escapeHtml(href)}" rel="noopener noreferrer ugc">${out}</a>`;
    }
    // Any other mark type: ignored, text preserved.
  }
  return out;
}

// ── Nodes ───────────────────────────────────────────────────────────────────────

/**
 * How a walk renders. `section` is a section body's render (Admin v2 E10, the Text block): a
 * heading or a list item with no words in it, and a list, quote or code block left with
 * nothing in it, render nothing, where an article's body keeps them as before (its output is
 * held by the snapshots unchanged).
 */
interface Walk {
  section: boolean;
}

const ARTICLE: Walk = { section: false };
const SECTION: Walk = { section: true };

/** Whether some text under `node` is more than white space (a section body, so bounded). */
function hasWords(node: TiptapNode): boolean {
  if (node.type === 'text') return (node.text ?? '').trim() !== '';
  return (node.content ?? []).some(hasWords);
}

function renderChildren(nodes: TiptapNode[] | undefined, walk: Walk): string {
  return (nodes ?? []).map((node) => renderNode(node, walk)).join('');
}

/** A container's markup, or nothing in a section render when nothing is inside it. */
function wrap(tag: string, inner: string, walk: Walk): string {
  return walk.section && inner === '' ? '' : `<${tag}>${inner}</${tag}>`;
}

function renderNode(node: TiptapNode, walk: Walk): string {
  switch (node.type) {
    case 'text':
      return wrapWithMarks(escapeHtml(node.text ?? ''), node.marks);

    case 'paragraph': {
      const inner = renderChildren(node.content, walk);
      return inner.length > 0 ? `<p>${inner}</p>` : '';
    }

    case 'heading': {
      // An empty heading (H2 pressed on an empty line) is no heading: a section render skips
      // it, as it skips an empty list item below.
      if (walk.section && !hasWords(node)) return '';
      // Clamped to h2–h6. The page's <h1> is the entity title rendered by the layout;
      // a body that can emit its own <h1> produces two document headings, which is an
      // outline defect for screen readers (WCAG 2.2) before it is an SEO one.
      const raw = node.attrs?.['level'];
      const level = typeof raw === 'number' && raw >= 2 && raw <= 6 ? Math.floor(raw) : 2;
      return `<h${level}>${renderChildren(node.content, walk)}</h${level}>`;
    }

    case 'bulletList':
      return wrap('ul', renderChildren(node.content, walk), walk);
    case 'orderedList':
      return wrap('ol', renderChildren(node.content, walk), walk);
    case 'listItem':
      if (walk.section && !hasWords(node)) return '';
      return `<li>${renderChildren(node.content, walk)}</li>`;
    case 'blockquote':
      return wrap('blockquote', renderChildren(node.content, walk), walk);

    case 'codeBlock': {
      const lang = node.attrs?.['language'];
      // The language becomes a CLASS name, and it is re-derived from an allowlist
      // pattern rather than passed through — `class="language-<anything>"` is an
      // attribute-injection primitive if the value is authored.
      const cls =
        typeof lang === 'string' && /^[a-z0-9+#-]{1,20}$/i.test(lang)
          ? ` class="language-${lang.toLowerCase()}"`
          : '';
      const inner = renderChildren(node.content, walk);
      if (walk.section && inner === '') return '';
      return `<pre><code${cls}>${inner}</code></pre>`;
    }

    case 'horizontalRule':
      return '<hr />';
    case 'hardBreak':
      return '<br />';

    case 'image': {
      const src = sanitizeHref(node.attrs?.['src']);
      if (!src) return '';
      const alt = typeof node.attrs?.['alt'] === 'string' ? (node.attrs['alt'] as string) : '';
      const w = node.attrs?.['width'];
      const h = node.attrs?.['height'];
      // width/height are emitted when known: Pillar 2 budgets CLS at 0, and an
      // unsized image inside body copy is the classic source of layout shift.
      const dims =
        typeof w === 'number' && typeof h === 'number'
          ? ` width="${Math.round(w)}" height="${Math.round(h)}"`
          : '';
      return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"${dims} loading="lazy" decoding="async" />`;
    }

    case 'doc':
      return renderChildren(node.content, walk);

    default:
      // Unknown node: render its children, drop the wrapper. Content survives an
      // editor-extension upgrade; unrecognised markup never reaches the page.
      return renderChildren(node.content, walk);
  }
}

/** Validates then renders. Invalid input yields '' rather than throwing. */
export function renderTiptapToHtml(doc: unknown): string {
  const parsed = TiptapDocSchema.safeParse(doc);
  if (!parsed.success) return '';
  return renderChildren(parsed.data.content, ARTICLE);
}

/**
 * A section body (Admin v2 E10, the Text block's): checked by the section walk
 * (`sectionDocProblem`, packages/schemas/tiptap.ts: iterative, at most 300 nodes and 8 levels,
 * the editor's content model and attributes), then rendered by the same allowlist walk on the
 * JSON as stored. zod's recursive TiptapDocSchema is not run: it rebuilds its object schema
 * for every node, so one body at the cap cost about 6 ms warm and 13 ms cold to parse, where
 * the walk and this render together cost about 0.3 ms warm (Node 24, 2026-10-31; the figures
 * are in SECTION_DOC_MAX_NODES's note). Anything the walk accepts has only the keys
 * TiptapDocSchema keeps, so the JSON as stored is what that parse would have handed the
 * renderer. A body the walk refuses renders nothing; a heading or a list item with no words
 * renders nothing either (Walk above).
 */
export function renderSectionDocToHtml(doc: unknown): string {
  if (sectionDocProblem(doc) !== null) return '';
  return renderChildren((doc as TiptapDoc).content, SECTION);
}

/** Plain text of a document — used for excerpts and reading time. */
export function tiptapToPlainText(doc: unknown): string {
  const parsed = TiptapDocSchema.safeParse(doc);
  if (!parsed.success) return '';
  const parts: string[] = [];
  const walk = (nodes: TiptapNode[] | undefined): void => {
    for (const node of nodes ?? []) {
      if (node.type === 'text' && typeof node.text === 'string') parts.push(node.text);
      walk(node.content);
    }
  };
  walk(parsed.data.content);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/** Reading time in whole minutes, floor 1. 200 wpm is the usual editorial figure. */
export function readingMinutes(doc: unknown): number {
  const words = tiptapToPlainText(doc).split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}
