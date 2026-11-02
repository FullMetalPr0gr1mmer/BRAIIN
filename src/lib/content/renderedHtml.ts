import {
  ARTICLE_DOC_MAX_DEPTH,
  ARTICLE_DOC_MAX_MARKS,
  ARTICLE_DOC_MAX_NODES,
  keptHref,
} from '@schemas/tiptap';
import type { TiptapDoc, TiptapMark, TiptapNode } from '@schemas/tiptap';

// A blog post saved before it had a Tiptap `body` holds its words only in the `body_html`
// cache (the seed's posts do: 30-legacy-demo.json). The public page never emits that cache
// (H15, PRE-2: a staff token can write it straight through PostgREST, and the page sent it out
// with set:html, sanitised by nothing). Instead it is READ BACK into a Tiptap document here and
// rendered by the allowlist renderer like every other body, so the HTML a visitor receives is
// always the renderer's own.
//
// This is not an HTML sanitiser. It reads ONE language, the markup `renderTiptapToHtml` writes
// (src/lib/content/tiptap.ts), and refuses the whole value at the first thing that language
// cannot contain: another tag, another attribute or attribute order, an unescaped `<`, `>`, `"`
// or `'`, an entity the renderer does not write, a link or image address `keptHref` would not
// keep as written, a tag left open or closed out of order, markup inside a formatting tag that
// the renderer never puts there. Nothing is cleaned or repaired, so a cache the renderer wrote
// comes back as a document that renders to the same bytes (tests/lib/blogBody.spec.ts holds
// that over every article corpus), and anything else renders nothing.
//
// It is bounded like the walk it feeds (H15 review, SEC-1): a cache longer than
// RENDERED_HTML_MAX_LENGTH is refused before a character is read, and the reading stops at the
// first node past ARTICLE_DOC_MAX_NODES (the renderer renders such a document as nothing
// anyway). Unbounded, a flood of short paragraphs written around the API was built node by
// node before the renderer refused it: 100,000 of them cost over 100 ms of CPU on every
// edge-cache miss of the post page.

/**
 * The longest cache read back, in characters (128 K). Sized from the longest real article as the
 * renderer writes it (H15's as-built note): docs/security-exceptions.md, 11,000 words and 2,375
 * nodes, renders to 86 KB. Only a post saved before posts had a Tiptap source holds nothing but
 * this cache (the seed's two, a few KB each), so the cap needs room for an article, not for the
 * node cap's longest: reading a cache at it costs a few milliseconds a language at worst (one
 * paragraph of nothing but `&amp;`), where the length alone was unbounded.
 */
export const RENDERED_HTML_MAX_LENGTH = 131_072;

const ENTITIES: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

/** Escaped text exactly as the renderer's escapeHtml writes it. */
const ESCAPED_TEXT = /^(?:[^&<>"']|&(?:amp|lt|gt|quot|#39);)*$/;
const unescape = (value: string): string =>
  value.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity] ?? entity);

/** A text run up to the next tag, with nothing the renderer would have escaped left raw. */
function readText(raw: string): string | null {
  return ESCAPED_TEXT.test(raw) ? unescape(raw) : null;
}

/** An address the renderer writes (keptHref keeps it exactly as written), unescaped. */
function readAddress(raw: string): string | null {
  const value = readText(raw);
  return value !== null && keptHref(value) === value ? value : null;
}

/** The formatting tags, each the mark that writes it. */
const MARK_TAGS: Readonly<Record<string, string>> = {
  strong: 'bold',
  em: 'italic',
  s: 'strike',
  u: 'underline',
  code: 'code',
  sup: 'superscript',
  sub: 'subscript',
};

/** The block tags, each the node that writes it (and, for a heading, its level). */
const BLOCK_TAGS: Readonly<Record<string, TiptapNode>> = {
  p: { type: 'paragraph' },
  h2: { type: 'heading', attrs: { level: 2 } },
  h3: { type: 'heading', attrs: { level: 3 } },
  h4: { type: 'heading', attrs: { level: 4 } },
  h5: { type: 'heading', attrs: { level: 5 } },
  h6: { type: 'heading', attrs: { level: 6 } },
  ul: { type: 'bulletList' },
  ol: { type: 'orderedList' },
  li: { type: 'listItem' },
  blockquote: { type: 'blockquote' },
};

const own = <T>(record: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined;

const LINK = /^<a href="([^"]*)" rel="noopener noreferrer ugc">/;
const CODE_BLOCK = /^<pre><code(?: class="language-([a-z0-9+#-]{1,20})")?>/;
const IMAGE =
  /^<img src="([^"]*)" alt="([^"]*)"(?: width="(0|-?[1-9][0-9]{0,14})" height="(0|-?[1-9][0-9]{0,14})")? loading="lazy" decoding="async" \/>/;
const SIMPLE_OPEN = /^<([a-z][a-z0-9]*)>/;
const CLOSE = /^<\/([a-z][a-z0-9]*)>/;

/** An open element: the node it builds, or a formatting tag around the next run of words. */
interface Frame {
  /** The closing tag that ends it. */
  close: string;
  /** A block's node (its `content` is filled as children arrive); undefined for a mark. */
  node?: TiptapNode;
  /** A mark's own formatting; a mark holds one run of words, or one more mark. */
  mark?: TiptapMark;
  /** For a mark: whether it already holds its one child. */
  full?: boolean;
}

/**
 * The Tiptap document a cache of `renderTiptapToHtml`'s output was rendered from (one that
 * renders to the same bytes), or null when the value is anything else. Iterative, linear in the
 * text, no longer than RENDERED_HTML_MAX_LENGTH, and no deeper or longer than an article may be.
 */
export function docFromRenderedHtml(html: unknown): TiptapDoc | null {
  if (typeof html !== 'string' || html.length > RENDERED_HTML_MAX_LENGTH) return null;
  const root: TiptapNode = { type: 'doc', content: [] };
  const stack: Frame[] = [{ close: '', node: root }];
  /** The innermost block: where the next node goes. */
  const block = (): TiptapNode => {
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      const node = stack[i]!.node;
      if (node) return node;
    }
    return root;
  };
  /** The marks open now, outermost first (the order the renderer reads them in). */
  const marks = (): TiptapMark[] => stack.flatMap((frame) => (frame.mark ? [frame.mark] : []));
  const top = (): Frame => stack[stack.length - 1]!;
  /** A mark takes one child; anything after it, or a block inside it, is not the renderer's. */
  const placeInline = (): boolean => {
    const frame = top();
    if (!frame.mark) return true;
    if (frame.full) return false;
    frame.full = true;
    return true;
  };
  /** Every node the document holds, counted as the walk counts them (the doc not included). */
  let nodes = 0;
  /** Places a node; false once the document holds more nodes than an article may. */
  const append = (node: TiptapNode): boolean => {
    nodes += 1;
    if (nodes > ARTICLE_DOC_MAX_NODES) return false;
    const parent = block();
    (parent.content ??= []).push(node);
    return true;
  };

  let rest = html;
  while (rest.length > 0) {
    if (rest[0] !== '<') {
      const end = rest.indexOf('<');
      const run = end === -1 ? rest : rest.slice(0, end);
      rest = end === -1 ? '' : rest.slice(end);
      const text = readText(run);
      if (text === null || !placeInline()) return null;
      const runMarks = marks();
      const placed = append(
        runMarks.length > 0 ? { type: 'text', text, marks: runMarks } : { type: 'text', text },
      );
      if (!placed) return null;
      continue;
    }
    let match: RegExpExecArray | null;
    if ((match = CLOSE.exec(rest))) {
      const frame = top();
      if (stack.length === 1 || frame.close !== match[1]) return null;
      // A formatting tag closed around nothing held an empty run of words: `<strong></strong>`.
      if (frame.mark && !frame.full && !append({ type: 'text', text: '', marks: marks() })) {
        return null;
      }
      stack.pop();
      // `</code></pre>` closes a code block in one step.
      if (match[1] === 'code' && frame.node?.type === 'codeBlock') {
        if (!rest.startsWith('</code></pre>')) return null;
        rest = rest.slice('</code></pre>'.length);
        continue;
      }
      rest = rest.slice(match[0].length);
      continue;
    }
    if (rest.startsWith('<br />') || rest.startsWith('<hr />')) {
      if (top().mark) return null;
      if (!append({ type: rest.startsWith('<br') ? 'hardBreak' : 'horizontalRule' })) return null;
      rest = rest.slice('<br />'.length);
      continue;
    }
    if ((match = IMAGE.exec(rest))) {
      if (top().mark) return null;
      const src = readAddress(match[1]!);
      const alt = readText(match[2]!);
      if (src === null || alt === null) return null;
      const attrs: Record<string, unknown> = { src, alt };
      if (match[3] !== undefined) {
        attrs['width'] = Number(match[3]);
        attrs['height'] = Number(match[4]);
      }
      if (!append({ type: 'image', attrs })) return null;
      rest = rest.slice(match[0].length);
      continue;
    }
    if (stack.length > ARTICLE_DOC_MAX_DEPTH + ARTICLE_DOC_MAX_MARKS) return null;
    if ((match = LINK.exec(rest))) {
      const href = readAddress(match[1]!);
      if (href === null || !placeInline()) return null;
      stack.push({ close: 'a', mark: { type: 'link', attrs: { href } } });
      rest = rest.slice(match[0].length);
      continue;
    }
    if ((match = CODE_BLOCK.exec(rest))) {
      if (top().mark) return null;
      const node: TiptapNode = { type: 'codeBlock', content: [] };
      if (match[1] !== undefined) node.attrs = { language: match[1] };
      if (!append(node)) return null;
      stack.push({ close: 'code', node });
      rest = rest.slice(match[0].length);
      continue;
    }
    if ((match = SIMPLE_OPEN.exec(rest))) {
      const name = match[1]!;
      const markType = own(MARK_TAGS, name);
      const blockNode = own(BLOCK_TAGS, name);
      if (markType !== undefined) {
        if (!placeInline()) return null;
        stack.push({ close: name, mark: { type: markType } });
      } else if (blockNode !== undefined) {
        if (top().mark) return null;
        // Its own attrs (H15 code review, CR10): a spread alone would hand every heading of
        // every read-back BLOCK_TAGS' one attrs object, so a change to one changed them all.
        const node: TiptapNode = { ...blockNode, content: [] };
        if (blockNode.attrs !== undefined) node.attrs = { ...blockNode.attrs };
        if (!append(node)) return null;
        stack.push({ close: name, node });
      } else {
        return null;
      }
      rest = rest.slice(match[0].length);
      continue;
    }
    return null;
  }
  return stack.length === 1 ? (root as TiptapDoc) : null;
}
