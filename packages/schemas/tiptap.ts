import { z } from 'zod';

// The stored rich-text shape. Lives here because CLAUDE.md §8 puts one Zod schema per
// shape in `packages/schemas`, imported by site, admin and Edge Functions alike — the
// admin validates a body on the way IN, the public loaders validate it on the way OUT,
// and both have to mean the same thing by "a document".
//
// The RENDERER is deliberately not here: it is app logic with a security contract, and
// it lives in `src/lib/content/tiptap.ts`. This file only describes structure.

// `| undefined` on every optional is required, not noise: the project runs with
// `exactOptionalPropertyTypes`, under which `attrs?: X` means "may be absent, but never
// present-and-undefined" — which is not what `z.optional()` produces. Without it these
// hand-written interfaces and the inferred Zod types are not assignable to each other.
export interface TiptapMark {
  type: string;
  attrs?: Record<string, unknown> | undefined;
}

export interface TiptapNode {
  type: string;
  text?: string | undefined;
  attrs?: Record<string, unknown> | undefined;
  marks?: TiptapMark[] | undefined;
  content?: TiptapNode[] | undefined;
}

const MarkSchema: z.ZodType<TiptapMark> = z.object({
  type: z.string().max(40),
  attrs: z.record(z.string(), z.unknown()).optional(),
});

export const TiptapNodeSchema: z.ZodType<TiptapNode> = z.lazy(() =>
  z.object({
    type: z.string().max(40),
    text: z.string().optional(),
    attrs: z.record(z.string(), z.unknown()).optional(),
    marks: z.array(MarkSchema).optional(),
    content: z.array(TiptapNodeSchema).optional(),
  }),
);

export const TiptapDocSchema = z.object({
  type: z.literal('doc'),
  content: z.array(TiptapNodeSchema).optional(),
});
export type TiptapDoc = z.infer<typeof TiptapDocSchema>;

export const EMPTY_DOC: TiptapDoc = { type: 'doc', content: [] };

/** Locale-keyed rich text (CLAUDE.md §8: rich-text → locale-keyed JSONB). */
export const LocalizedDocSchema = z.object({
  en: TiptapDocSchema,
  ar: TiptapDocSchema.optional(),
});
export type LocalizedDoc = z.infer<typeof LocalizedDocSchema>;

// ── A section's rich text (Admin v2 E10, the Text block) ──────────────────────────
//
// CLAUDE.md §3: "Tiptap sanitised on write AND render". The render half is the allowlist
// renderer (src/lib/content/tiptap.ts `renderSectionDocToHtml`), which every public render runs
// on the stored JSON after this same walk. This is the write half for section content: a
// STRICT document, exactly what the admin's editor makes (RichText.tsx: Tiptap 3's StarterKit,
// headings 2 to 4) and the renderer emits, so a document the renderer would silently alter (an
// image, a node or mark it drops, a link it unwraps, a heading it clamps, a list item outside a
// list) is refused with a 422 instead of being stored. Attributes are held to the editor's own,
// by node and mark type and by name, with scalar values only, so nothing rides in a body that
// the renderer never reads (a `mediaId` there would make that asset anon-readable, 0102).
// tests/lib/sectionBlocks.spec.ts checks the content model and the attributes against the
// editor's own ProseMirror schema.

/** Node types a section body may hold: what StarterKit makes and the renderer emits. */
export const SECTION_DOC_NODES = [
  'paragraph',
  'text',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'blockquote',
  'codeBlock',
  'horizontalRule',
  'hardBreak',
] as const;

/** Marks a section body may carry (the renderer's own list, less its aliases). */
export const SECTION_DOC_MARKS = ['bold', 'italic', 'strike', 'underline', 'code', 'link'] as const;

/** The heading levels the editor offers (the section's own heading is the h2 above them). */
export const SECTION_DOC_HEADING_LEVELS = [2, 3, 4] as const;

/**
 * How deep a body may nest (a list in a quote in a list item is four) and how many nodes it may
 * hold (a paragraph and its text are two; 300 is some fifty formatted paragraphs). The walk below
 * and the section renderer (renderSectionDocToHtml) visit each node once, so both are linear in
 * it. At the cap (100 paragraphs, each a bold run and a link), measured in Node 24 on 2026-10-31
 * and again on 2026-11-01 with the machine under load: the walk 0.2 to 0.9 ms and the walk with
 * the render 0.3 to 1.4 ms warm, 1 to 9.5 ms the first time a process runs them. zod's recursive
 * TiptapDocSchema, which renderTiptapToHtml parses with, costs 6 to 26 ms warm and 13 to 55 ms
 * the first time on the same body (15 to 30 times more), so the Text block does not use it. The
 * Workers Free plan allows 10 ms of CPU a request: a body at the cap fits warm with room, but a
 * page of many full blocks, or the first render in a new isolate, can come near it, so the cap
 * is a size bound that keeps one block cheap, not a promise for a page.
 * tests/lib/sectionBlocks.spec.ts bounds the render (3 ms, warm, fastest of 20) and holds both
 * walks linear.
 */
export const SECTION_DOC_MAX_DEPTH = 8;
export const SECTION_DOC_MAX_NODES = 300;

const SAME_SITE = 'https://same-site.invalid';
const LINK_SCHEMES: readonly string[] = ['http:', 'https:', 'mailto:', 'tel:'];

/**
 * Whether the renderer keeps this href (src/lib/content/tiptap.ts `sanitizeHref`): an http,
 * https, mailto or tel URL, or a reference that stays on this site. Restated here because the
 * schema module may not import the app; tests/lib/sectionBlocks.spec.ts holds the two equal
 * over a table of hostile and ordinary hrefs.
 */
export function sectionHrefKept(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  const href = raw.trim();
  if (href.length === 0 || href.length > 2048) return false;
  try {
    if (href.startsWith('/') || href.startsWith('#') || href.startsWith('?')) {
      return new URL(href, SAME_SITE).origin === SAME_SITE;
    }
    return LINK_SCHEMES.includes(new URL(href).protocol);
  } catch {
    return false;
  }
}

const NODES: readonly string[] = SECTION_DOC_NODES;
const MARKS: readonly string[] = SECTION_DOC_MARKS;
const LEVELS: readonly unknown[] = SECTION_DOC_HEADING_LEVELS;
const CODE_LANGUAGE = /^[a-z0-9+#-]{1,20}$/i;

/** The blocks: what a document, a quote and a list item hold (StarterKit's `block` group). */
const BLOCKS: readonly string[] = [
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'blockquote',
  'codeBlock',
  'horizontalRule',
];

/**
 * What each node may hold: StarterKit's content model (doc and blockquote `block+`, listItem
 * `paragraph block*`, the lists `listItem+`, paragraph and heading `inline*`, codeBlock `text*`).
 * A type with no entry holds nothing: text, a line break, a rule.
 */
const HOLDS: Readonly<Record<string, readonly string[]>> = {
  doc: BLOCKS,
  blockquote: BLOCKS,
  listItem: BLOCKS,
  bulletList: ['listItem'],
  orderedList: ['listItem'],
  paragraph: ['text', 'hardBreak'],
  heading: ['text', 'hardBreak'],
  codeBlock: ['text'],
};

/** The ones that hold at least one node (StarterKit's `+`; a list item's first paragraph). */
const NEVER_EMPTY: readonly string[] = ['blockquote', 'listItem', 'bulletList', 'orderedList'];

/**
 * Nodes that may carry marks: text, and a line break. ProseMirror's addMark marks every inline
 * node in a range, so Bold over two lines (or a pasted `<b>a<br>b</b>`) marks the line break
 * too; its `<br />` is the same either way.
 */
const MARKED: readonly string[] = ['text', 'hardBreak'];

/**
 * A value the editor writes into a passive attribute (one the renderer never reads): Tiptap
 * reads a pasted attribute as text, or as a number or true/false when it looks like one.
 */
const scalar = (v: unknown): boolean =>
  v === null ||
  typeof v === 'boolean' ||
  (typeof v === 'number' && Number.isFinite(v)) ||
  (typeof v === 'string' && v.length <= 2048);

/**
 * Every attribute a node or a mark may carry, by name, with what its value may be: the
 * editor's own (tiptap 3.31: heading `level`, orderedList `start` and `type`, codeBlock
 * `language`, link `href`, `target`, `rel`, `class` and `title`). A type with no entry carries
 * none (an empty object, as ProseMirror may write, is none).
 */
const ATTRS: Readonly<Record<string, Readonly<Record<string, (v: unknown) => boolean>>>> = {
  heading: { level: (v) => LEVELS.includes(v) },
  // A pasted `start` that is not a number is stored as null (NaN in JSON).
  orderedList: {
    start: (v) => v === null || Number.isSafeInteger(v),
    type: (v) => v === null || (typeof v === 'string' && v.length <= 20),
  },
  codeBlock: { language: (v) => v === null || (typeof v === 'string' && CODE_LANGUAGE.test(v)) },
  link: { href: sectionHrefKept, target: scalar, rel: scalar, class: scalar, title: scalar },
};

/** The attributes the renderer reads, so a node or mark without them is refused. */
const REQUIRED: Readonly<Record<string, string>> = { heading: 'level', link: 'href' };

const NODE_KEYS: readonly string[] = ['type', 'text', 'attrs', 'marks', 'content'];
const MARK_KEYS: readonly string[] = ['type', 'attrs'];

// What an editor is told (P-12: plain words, never the editor's internal names).
const UNREADABLE = 'This text could not be read. Write it again in the editor.';
const TOO_LONG = 'This text is too long for one block. Split it into two Text blocks.';
const TOO_DEEP = 'This text has too many levels inside each other. Use fewer lists inside lists.';
const SETTINGS = 'This text carries settings the editor does not make.';
const NO_WORDS = 'Write some text.';
const LEVEL = 'A heading inside the text is level 2, 3 or 4.';
const LANGUAGE = 'A code block’s language is a short name, such as css or ts.';
const LINK =
  'A link goes to a web address (https://…), a page of this site, an email (mailto:) or a phone (tel:).';
const TWICE = 'The same formatting is set twice on the same words.';
const PLAIN_CODE = 'A code block holds plain text only.';
const LEAF: Readonly<Record<string, string>> = {
  hardBreak: 'A line break holds nothing inside it.',
  horizontalRule: 'A dividing line holds nothing inside it.',
};
const EMPTY: Readonly<Record<string, string>> = {
  blockquote: 'A quote holds at least one paragraph.',
  listItem: 'A list item holds at least one paragraph.',
  bulletList: 'A list holds at least one item.',
  orderedList: 'A list holds at least one item.',
};

/**
 * A type or a mark's type as it may be quoted back. Never `String()` of a non-string: a nested
 * array's `String()` recurses through Array.prototype.join, and a deep one overflows the stack.
 */
const labelOf = (v: unknown): string => (typeof v === 'string' ? v.slice(0, 40) : typeof v);

/** Why a node of `type` may not sit in `parent` (both known types), in an editor's words. */
function misplaced(parent: string, type: string): string {
  if (type === 'listItem') return 'A list item sits inside a list.';
  if (parent === 'bulletList' || parent === 'orderedList') return 'A list holds list items only.';
  if (parent === 'codeBlock') return PLAIN_CODE;
  if (parent === 'paragraph' || parent === 'heading') {
    return 'A paragraph or a heading holds words and line breaks only.';
  }
  return 'Words sit inside a paragraph, a heading or a list.';
}

type Raw = Record<string, unknown>;
const isObject = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const onlyKeys = (v: Raw, keys: readonly string[]): boolean =>
  Object.keys(v).every((k) => keys.includes(k));

/** The words for a missing or wrong attribute the renderer reads. */
const READ_ATTR: Readonly<Record<string, string>> = {
  level: LEVEL,
  language: LANGUAGE,
  href: LINK,
};

/**
 * A record's OWN entry for a key the input chose, or undefined. A plain object literal inherits
 * Object.prototype, so `allowed['constructor']` or `allowed['toString']` would find a function
 * and accept any value, and `__proto__` or `hasOwnProperty` would make the check throw (E10
 * check: a hidden mediaId rode in through `constructor`, and a 500).
 */
function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** Why a node's or a mark's `attrs` is not the editor's, or null. */
function attrsProblem(type: string, attrs: unknown): string | null {
  const required = REQUIRED[type];
  if (attrs === undefined) return required === undefined ? null : (READ_ATTR[required] ?? SETTINGS);
  if (!isObject(attrs)) return UNREADABLE;
  const allowed = ATTRS[type] ?? {};
  for (const [name, value] of Object.entries(attrs)) {
    const rule = own(allowed, name);
    if (rule === undefined) return SETTINGS;
    if (!rule(value)) return own(READ_ATTR, name) ?? SETTINGS;
  }
  if (required !== undefined && !(required in attrs)) return READ_ATTR[required] ?? SETTINGS;
  return null;
}

/** Why a node's `marks` are not the editor's, or null. `parent` is the node's container. */
function marksProblem(type: string, parent: string, marks: unknown): string | null {
  if (!MARKED.includes(type) || !Array.isArray(marks)) return UNREADABLE;
  // A code block's text carries no formatting (StarterKit's codeBlock takes no marks).
  if (parent === 'codeBlock') return PLAIN_CODE;
  // At most one of each: counted before the list is read, so a long list costs nothing.
  if (marks.length > MARKS.length) return TWICE;
  const seen: string[] = [];
  for (const mark of marks as unknown[]) {
    if (!isObject(mark) || !onlyKeys(mark, MARK_KEYS)) return UNREADABLE;
    const markType = mark['type'];
    if (typeof markType !== 'string' || !MARKS.includes(markType)) {
      return `A Text block cannot show this formatting ("${labelOf(markType)}").`;
    }
    if (seen.includes(markType)) return TWICE;
    seen.push(markType);
    const problem = attrsProblem(markType, mark['attrs']);
    if (problem) return problem;
  }
  return null;
}

/**
 * The first reason a value is not a section body, or null. Iterative and bounded (at most
 * SECTION_DOC_MAX_NODES nodes, SECTION_DOC_MAX_DEPTH deep), and it reads the raw JSON itself:
 * zod's recursive TiptapNodeSchema is never run on a section body, because inside the 64 KB
 * payload a document can nest about 1,900 deep, where that recursion overflows the stack
 * (a RangeError, not an issue), and even 500 deep costs it tens of milliseconds. Nothing here
 * recurses or stringifies a value it was given (labelOf). Anything this walk accepts is a
 * TiptapDoc that TiptapDocSchema also accepts unchanged (tests/lib/sectionBlocks.spec.ts).
 */
export function sectionDocProblem(raw: unknown): string | null {
  if (!isObject(raw) || raw['type'] !== 'doc' || !onlyKeys(raw, ['type', 'content'])) {
    return UNREADABLE;
  }
  const top = raw['content'];
  if (top !== undefined && !Array.isArray(top)) return UNREADABLE;
  const stack: { node: unknown; depth: number; parent: string }[] = ((top ?? []) as unknown[]).map(
    (node) => ({ node, depth: 1, parent: 'doc' }),
  );
  let seen = 0;
  let words = false;
  while (stack.length > 0) {
    const { node, depth, parent } = stack.pop()!;
    seen += 1;
    if (seen > SECTION_DOC_MAX_NODES) return TOO_LONG;
    if (depth > SECTION_DOC_MAX_DEPTH) return TOO_DEEP;
    if (!isObject(node) || !onlyKeys(node, NODE_KEYS)) return UNREADABLE;
    const { type, text, attrs, marks, content } = node;
    if (typeof type !== 'string' || !NODES.includes(type)) {
      return type === 'image'
        ? 'Pictures go in a Gallery section, not in a Text block.'
        : `A Text block cannot show this part of the text ("${labelOf(type)}").`;
    }
    if (!(HOLDS[parent] ?? []).includes(type)) return misplaced(parent, type);
    const attrsIssue = attrsProblem(type, attrs);
    if (attrsIssue) return attrsIssue;
    if (content !== undefined && !Array.isArray(content)) return UNREADABLE;
    if (type === 'text') {
      if (typeof text !== 'string' || content !== undefined) return UNREADABLE;
      if (text.trim() !== '') words = true;
    } else if (text !== undefined) {
      return UNREADABLE;
    }
    if (marks !== undefined) {
      const marksIssue = marksProblem(type, parent, marks);
      if (marksIssue) return marksIssue;
    }
    const holds = HOLDS[type];
    if (holds === undefined) {
      if (content !== undefined) return LEAF[type] ?? UNREADABLE;
      continue;
    }
    const children = (content ?? []) as unknown[];
    if (children.length === 0 && NEVER_EMPTY.includes(type)) return EMPTY[type] ?? UNREADABLE;
    // A list item opens with a paragraph (`paragraph block*`).
    if (type === 'listItem' && !(isObject(children[0]) && children[0]['type'] === 'paragraph')) {
      return 'A list item starts with a paragraph.';
    }
    for (const child of children) stack.push({ node: child, depth: depth + 1, parent: type });
  }
  return words ? null : NO_WORDS;
}

/**
 * One language of a section body: a document {@link sectionDocProblem} finds nothing in. Not
 * built on TiptapDocSchema (see that function), but its output is a TiptapDoc.
 */
export const SectionDocSchema = z.unknown().superRefine((doc, ctx) => {
  const problem = sectionDocProblem(doc);
  if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
}) as unknown as z.ZodType<TiptapDoc>;

/**
 * A section's rich text in both languages (the Text block's body). Both are required, as every
 * section text is (packages/schemas/sections.ts): the copy is indexable, and an Arabic page
 * must not render English or nothing.
 */
export const SectionBodySchema = z.object({ en: SectionDocSchema, ar: SectionDocSchema }).strict();
export type SectionBody = z.infer<typeof SectionBodySchema>;
