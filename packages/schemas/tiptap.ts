import { z } from 'zod';
import { isWordText } from './docWords';

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

/**
 * One node of a document. The object is built ONCE (H15): `z.lazy(() => z.object(...))` built a
 * new object schema for every node it parsed, about ten times the cost of the parse itself
 * (E10-S3). Only `content` is lazy, to reach the node schema it is part of. No public render or
 * write runs it any more (an article body is read by `readArticleDoc`, a section body by
 * `sectionDocProblem`, both iterative and bounded); it stays the stored shape's one statement,
 * which those walks are held to (tests/lib/articleDoc.spec.ts).
 */
const TiptapNodeObject: z.ZodType<TiptapNode> = z.object({
  type: z.string().max(40),
  text: z.string().optional(),
  attrs: z.record(z.string(), z.unknown()).optional(),
  marks: z.array(MarkSchema).optional(),
  content: z.array(z.lazy(() => TiptapNodeObject)).optional(),
});
export const TiptapNodeSchema: z.ZodType<TiptapNode> = TiptapNodeObject;

export const TiptapDocSchema = z.object({
  type: z.literal('doc'),
  content: z.array(TiptapNodeSchema).optional(),
});
export type TiptapDoc = z.infer<typeof TiptapDocSchema>;

export const EMPTY_DOC: TiptapDoc = { type: 'doc', content: [] };

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
 * The href a link may carry, trimmed, or null to drop the link (its words stay): an http, https,
 * mailto or tel URL, or a reference that stays on this site. The ONE rule, here because the
 * schema module may not import the app: the renderer's `sanitizeHref` (src/lib/content/tiptap.ts)
 * IS this function (E10 code review, CR6), and the section walk refuses a link it would drop.
 *
 * A relative href is resolved against a throwaway base and kept only when it stays on that
 * base's origin. The base is invented, but the answer does not depend on it: a same-site
 * reference resolves onto whatever origin it is given, while scheme-relative `//evil.example`
 * and `/\evil.example` (the URL standard reads a backslash as a slash in an https URL) resolve
 * to another host from ANY base. Both look harmless precisely because they are absolute
 * cross-origin URLs wearing a relative costume.
 */
export function keptHref(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const href = raw.trim();
  if (href.length === 0 || href.length > 2048) return null;
  try {
    if (href.startsWith('/') || href.startsWith('#') || href.startsWith('?')) {
      return new URL(href, SAME_SITE).origin === SAME_SITE ? href : null;
    }
    return LINK_SCHEMES.includes(new URL(href).protocol) ? href : null;
  } catch {
    return null;
  }
}

/** Whether the renderer keeps this href (keptHref answers with it). */
export function sectionHrefKept(raw: unknown): boolean {
  return keptHref(raw) !== null;
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
  // The node budget is checked before a list is read (E10 code review, CR8): a 64 KB payload
  // can hold a content array of some 16,000 entries, and copying it onto the stack first would
  // allocate for every one before TOO_LONG.
  if ((top ?? []).length > SECTION_DOC_MAX_NODES) return TOO_LONG;
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
      if (isWordText(node)) words = true;
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
    // Every node already on the stack is counted later, so this is the same budget, checked
    // before the children are copied (CR8).
    if (seen + stack.length + children.length > SECTION_DOC_MAX_NODES) return TOO_LONG;
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

/** What an editor is told when a language's text is missing altogether (P-12, E10 CR2). */
export const SECTION_BODY_MISSING = {
  en: 'Write the English text.',
  ar: 'Write the Arabic text.',
} as const;

/** One language of a section body, by name: a missing one says which (not UNREADABLE). */
const sectionDocIn = (lang: 'en' | 'ar') =>
  z.unknown().superRefine((doc, ctx) => {
    const problem = doc === undefined ? SECTION_BODY_MISSING[lang] : sectionDocProblem(doc);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
  }) as unknown as z.ZodType<TiptapDoc>;

/**
 * A section's rich text in both languages (the Text block's body). Both are required, as every
 * section text is (packages/schemas/sections.ts): the copy is indexable, and an Arabic page
 * must not render English or nothing. A language left out is named ("Write the Arabic text.").
 */
export const SectionBodySchema = z
  .object({ en: sectionDocIn('en'), ar: sectionDocIn('ar') })
  .strict();
export type SectionBody = z.infer<typeof SectionBodySchema>;

// ── An article's rich text (H15): blog posts, services and projects ───────────────────
//
// An article body is read by the renderer that has always taken it (src/lib/content/tiptap.ts
// `renderTiptapToHtml`): every node and mark it ever took, images, h1 to h6 and unknown types
// included, so it is NOT held to the section allowlist above (stored bodies would stop
// rendering). What it may not be is unbounded. zod's recursive TiptapNodeSchema overflowed the
// stack at about 1,250 levels (42 KB): a RangeError, so a 500 on save, and a body stored around
// the API (a staff token straight to PostgREST) made a service page a 500 on every request and
// emptied the case-study index (E10 review, PRE-1). It cost tens of milliseconds on an ordinary
// long body besides.
//
// `readArticleDoc` walks the raw JSON once, iteratively, and never recurses or stringifies a
// value it was given. It accepts exactly what TiptapDocSchema accepts, within the bounds below,
// and answers zod's own output for it (unknown keys dropped, as the parse dropped them), so a
// save stores what it stored before and the renderer, given the JSON as stored, writes the bytes
// it wrote from the parse (tests/lib/articleDoc.spec.ts holds both, over a seeded corpus;
// tests/lib/articleRender.spec.ts holds the renders to the bytes before H15).

/**
 * How long, deep and formatted an article may be. Sized from long real articles: the
 * repository's own documents as the editor stores them (H15's as-built note) run 437 to 2,375
 * nodes for 2,500 to 11,000 words, never deeper than 6, with a third as many marks as nodes and
 * a few attribute values a link or heading. So 5,000 nodes is some 23,000 words; 32 levels is
 * fifteen lists inside lists; 16 marks on one run of words is more than the editor has kinds of
 * formatting; 20,000 marks and attribute values together is four times the longest measured. An
 * attribute value nests at most 8 deep (the editor writes scalars). At the caps the walk and the
 * render together stay a few milliseconds warm (tests/lib/articleDoc.spec.ts measures it).
 */
export const ARTICLE_DOC_MAX_NODES = 5_000;
export const ARTICLE_DOC_MAX_DEPTH = 32;
export const ARTICLE_DOC_MAX_MARKS = 16;
export const ARTICLE_DOC_MAX_FORMATTING = 20_000;
export const ARTICLE_ATTR_MAX_DEPTH = 8;

const ARTICLE_TOO_LONG = 'This text is too long to save. Shorten it and save again.';
const ARTICLE_FORMATTING = 'This text carries too much formatting. Remove some and save again.';

/** A node's or a mark's type as zod's `z.string().max(40)` takes it. */
const shortType = (v: unknown): boolean => typeof v === 'string' && v.length <= 40;

/**
 * Whether `attrs` (a record TiptapNodeSchema takes) fits the formatting budget and the attribute
 * depth: every value inside it, however nested, counts once.
 */
function attrsFit(attrs: Raw, budget: { left: number }): boolean {
  const stack: { value: unknown; depth: number }[] = [{ value: attrs, depth: 1 }];
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    const entries: unknown[] = Array.isArray(value) ? value : Object.values(value as Raw);
    // Counted before any entry is read (E10 CR8): a wide value costs nothing past the budget.
    budget.left -= entries.length;
    if (budget.left < 0) return false;
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null) continue;
      if (depth >= ARTICLE_ATTR_MAX_DEPTH) return false;
      stack.push({ value: entry, depth: depth + 1 });
    }
  }
  return true;
}

/** zod's record output: every key but `__proto__`, each value as it was (z.unknown()). */
function recordCopy(attrs: Raw): Raw {
  const out: Raw = {};
  for (const key in attrs) {
    if (key !== '__proto__') out[key] = attrs[key];
  }
  return out;
}

/** zod's object output: the shape's keys in its order, each one the input holds. */
function objectCopy(raw: Raw, keys: readonly string[], values: Raw): Raw {
  const out: Raw = {};
  for (const key of keys) {
    if (key in raw) out[key] = values[key];
  }
  return out;
}

const DOC_KEYS: readonly string[] = ['type', 'content'];

/** The reason a value is not an article body, or the body as TiptapDocSchema parses it. */
export type ArticleDocRead = { problem: string } | { doc: TiptapDoc };

interface ArticleFrame {
  node: unknown;
  depth: number;
  /** Where the node's copy goes (the parent's copied `content`), when copying. */
  into: unknown[] | undefined;
  at: number;
}

/**
 * Reads an article body: the first reason it is not one, or the document as TiptapDocSchema
 * parses it. With `copy` false it only checks (the renderer reads the JSON as stored) and
 * answers the value itself.
 */
export function readArticleDoc(raw: unknown, copy = true): ArticleDocRead {
  if (!isObject(raw) || raw['type'] !== 'doc') return { problem: UNREADABLE };
  const top = raw['content'];
  if (top !== undefined && !Array.isArray(top)) return { problem: UNREADABLE };
  const list = (top ?? []) as unknown[];
  // The node budget is checked before a list is read (E10 CR8).
  if (list.length > ARTICLE_DOC_MAX_NODES) return { problem: ARTICLE_TOO_LONG };
  const topCopy = copy && top !== undefined ? new Array<unknown>(list.length) : undefined;
  const stack: ArticleFrame[] = [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    stack.push({ node: list[i], depth: 1, into: topCopy, at: i });
  }
  const budget = { left: ARTICLE_DOC_MAX_FORMATTING };
  let seen = 0;
  while (stack.length > 0) {
    const { node, depth, into, at } = stack.pop()!;
    seen += 1;
    if (seen > ARTICLE_DOC_MAX_NODES) return { problem: ARTICLE_TOO_LONG };
    if (depth > ARTICLE_DOC_MAX_DEPTH) return { problem: TOO_DEEP };
    if (!isObject(node)) return { problem: UNREADABLE };
    const { type, text, attrs, marks, content } = node;
    if (!shortType(type)) return { problem: UNREADABLE };
    if (text !== undefined && typeof text !== 'string') return { problem: UNREADABLE };
    if (attrs !== undefined) {
      if (!isObject(attrs)) return { problem: UNREADABLE };
      if (!attrsFit(attrs, budget)) {
        return { problem: budget.left < 0 ? ARTICLE_FORMATTING : SETTINGS };
      }
    }
    let marksCopy: unknown[] | undefined;
    if (marks !== undefined) {
      if (!Array.isArray(marks)) return { problem: UNREADABLE };
      // Counted before the list is read, like the nodes.
      if (marks.length > ARTICLE_DOC_MAX_MARKS) return { problem: ARTICLE_FORMATTING };
      budget.left -= marks.length;
      if (budget.left < 0) return { problem: ARTICLE_FORMATTING };
      if (copy) marksCopy = new Array<unknown>(marks.length);
      for (let m = 0; m < marks.length; m += 1) {
        const mark: unknown = marks[m];
        if (!isObject(mark) || !shortType(mark['type'])) return { problem: UNREADABLE };
        const markAttrs = mark['attrs'];
        if (markAttrs !== undefined) {
          if (!isObject(markAttrs)) return { problem: UNREADABLE };
          if (!attrsFit(markAttrs, budget)) {
            return { problem: budget.left < 0 ? ARTICLE_FORMATTING : SETTINGS };
          }
        }
        if (marksCopy) {
          marksCopy[m] = objectCopy(mark, MARK_KEYS, {
            type: mark['type'],
            attrs: isObject(markAttrs) ? recordCopy(markAttrs) : markAttrs,
          });
        }
      }
    }
    if (content !== undefined && !Array.isArray(content)) return { problem: UNREADABLE };
    const children = (content ?? []) as unknown[];
    // Every node already on the stack is counted later, so this is the same budget, checked
    // before the children are copied onto it (E10 CR8).
    if (seen + stack.length + children.length > ARTICLE_DOC_MAX_NODES) {
      return { problem: ARTICLE_TOO_LONG };
    }
    const childCopy =
      copy && content !== undefined ? new Array<unknown>(children.length) : undefined;
    if (into) {
      into[at] = objectCopy(node, NODE_KEYS, {
        type,
        text,
        attrs: isObject(attrs) ? recordCopy(attrs) : attrs,
        marks: marksCopy ?? marks,
        content: childCopy ?? content,
      });
    }
    for (let i = children.length - 1; i >= 0; i -= 1) {
      stack.push({ node: children[i], depth: depth + 1, into: childCopy, at: i });
    }
  }
  if (!copy) return { doc: raw as TiptapDoc };
  return { doc: objectCopy(raw, DOC_KEYS, { type: 'doc', content: topCopy ?? top }) as TiptapDoc };
}

/** The first reason a value is not an article body, or null (a check: nothing is copied). */
export function articleDocProblem(raw: unknown): string | null {
  const read = readArticleDoc(raw, false);
  return 'problem' in read ? read.problem : null;
}

/**
 * One language of an article body, read by {@link readArticleDoc}, never by zod's recursive node
 * schema. A missing language says which (the English one is required).
 */
const articleDocIn = (lang: 'en' | 'ar') =>
  z.unknown().transform((doc, ctx): TiptapDoc => {
    const read: ArticleDocRead =
      doc === undefined ? { problem: SECTION_BODY_MISSING[lang] } : readArticleDoc(doc);
    if ('doc' in read) return read.doc;
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: read.problem });
    return z.NEVER;
  });

/**
 * Locale-keyed rich text (CLAUDE.md §8: rich-text → locale-keyed JSONB): an article's body, the
 * English required and the Arabic optional, each read by {@link readArticleDoc} (H15).
 */
export const LocalizedDocSchema = z.object({
  en: articleDocIn('en'),
  ar: articleDocIn('ar').optional(),
});
export type LocalizedDoc = z.infer<typeof LocalizedDocSchema>;
