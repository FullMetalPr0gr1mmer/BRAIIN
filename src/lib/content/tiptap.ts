import { TiptapDocSchema, type TiptapMark, type TiptapNode } from '@schemas/tiptap';

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
 * Relative URLs are allowed by prefix check rather than by parsing, because parsing a
 * relative URL requires inventing a base and the answer would then depend on the base
 * we invented. Scheme-relative `//evil.example` is rejected for the same reason it
 * looks harmless: it is an absolute cross-origin URL wearing a relative costume.
 */
export function sanitizeHref(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const href = raw.trim();
  if (href.length === 0 || href.length > 2048) return null;
  if (href.startsWith('//')) return null;
  if (href.startsWith('/') || href.startsWith('#') || href.startsWith('?')) return href;
  try {
    const parsed = new URL(href);
    return ALLOWED_SCHEMES.has(parsed.protocol) ? href : null;
  } catch {
    return null;
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

function renderChildren(nodes: TiptapNode[] | undefined): string {
  return (nodes ?? []).map(renderNode).join('');
}

function renderNode(node: TiptapNode): string {
  switch (node.type) {
    case 'text':
      return wrapWithMarks(escapeHtml(node.text ?? ''), node.marks);

    case 'paragraph': {
      const inner = renderChildren(node.content);
      return inner.length > 0 ? `<p>${inner}</p>` : '';
    }

    case 'heading': {
      // Clamped to h2–h6. The page's <h1> is the entity title rendered by the layout;
      // a body that can emit its own <h1> produces two document headings, which is an
      // outline defect for screen readers (WCAG 2.2) before it is an SEO one.
      const raw = node.attrs?.['level'];
      const level = typeof raw === 'number' && raw >= 2 && raw <= 6 ? Math.floor(raw) : 2;
      return `<h${level}>${renderChildren(node.content)}</h${level}>`;
    }

    case 'bulletList':
      return `<ul>${renderChildren(node.content)}</ul>`;
    case 'orderedList':
      return `<ol>${renderChildren(node.content)}</ol>`;
    case 'listItem':
      return `<li>${renderChildren(node.content)}</li>`;
    case 'blockquote':
      return `<blockquote>${renderChildren(node.content)}</blockquote>`;

    case 'codeBlock': {
      const lang = node.attrs?.['language'];
      // The language becomes a CLASS name, and it is re-derived from an allowlist
      // pattern rather than passed through — `class="language-<anything>"` is an
      // attribute-injection primitive if the value is authored.
      const cls =
        typeof lang === 'string' && /^[a-z0-9+#-]{1,20}$/i.test(lang)
          ? ` class="language-${lang.toLowerCase()}"`
          : '';
      return `<pre><code${cls}>${renderChildren(node.content)}</code></pre>`;
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
      return renderChildren(node.content);

    default:
      // Unknown node: render its children, drop the wrapper. Content survives an
      // editor-extension upgrade; unrecognised markup never reaches the page.
      return renderChildren(node.content);
  }
}

/** Validates then renders. Invalid input yields '' rather than throwing. */
export function renderTiptapToHtml(doc: unknown): string {
  const parsed = TiptapDocSchema.safeParse(doc);
  if (!parsed.success) return '';
  return renderChildren(parsed.data.content);
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
