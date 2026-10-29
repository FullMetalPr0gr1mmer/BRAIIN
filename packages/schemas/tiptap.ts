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
// renderer (src/lib/content/tiptap.ts), which every public render runs on the stored JSON.
// This is the write half for section content: a STRICT document, exactly what the admin's
// editor makes (RichText.tsx: StarterKit, headings 2 to 4) and the renderer emits, so a
// document the renderer would silently alter (an image, a node or mark it drops, a link it
// unwraps, a heading it clamps) is refused with a 422 instead of being stored. Attributes the
// renderer never reads (a link's target or rel, a list's start) are left alone; the ones it
// does read are held to what it keeps.

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
 * hold (a paragraph and its text are two; 300 is some fifty formatted paragraphs). The count is
 * also a CPU bound: the allowlist renderer parses the document with zod on every render, about
 * 0.03 to 0.06 ms a node measured, against the Workers Free plan's 10 ms a request.
 */
export const SECTION_DOC_MAX_DEPTH = 8;
export const SECTION_DOC_MAX_NODES = 300;

const SAME_SITE = 'https://same-site.invalid';
const LINK_SCHEMES: readonly string[] = ['http:', 'https:', 'mailto:', 'tel:'];

/**
 * Whether the renderer keeps this href (src/lib/content/tiptap.ts `sanitizeHref`): an http,
 * https, mailto or tel URL, or a reference that stays on this site. Restated here because the
 * schema module may not import the app; tests/lib/sectionDoc.spec.ts holds the two equal over
 * a table of hostile and ordinary hrefs.
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

const NODE_KEYS: readonly string[] = ['type', 'text', 'attrs', 'marks', 'content'];
const MARK_KEYS: readonly string[] = ['type', 'attrs'];

type Raw = Record<string, unknown>;
const isObject = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const onlyKeys = (v: Raw, keys: readonly string[]): boolean =>
  Object.keys(v).every((k) => keys.includes(k));

/**
 * The first reason a value is not a section body, or null. Iterative and bounded (at most
 * SECTION_DOC_MAX_NODES nodes, SECTION_DOC_MAX_DEPTH deep), and it reads the raw JSON itself:
 * zod's recursive TiptapNodeSchema is never run on a section body, because inside the 64 KB
 * payload a document can nest about 1,900 deep, where that recursion overflows the stack
 * (a RangeError, not an issue), and even 500 deep costs it tens of milliseconds. Anything this
 * walk accepts is a TiptapDoc that TiptapDocSchema also accepts unchanged
 * (tests/lib/sectionBlocks.spec.ts), so the renderer's own parse of it is shallow and short.
 */
export function sectionDocProblem(raw: unknown): string | null {
  if (!isObject(raw) || raw['type'] !== 'doc' || !onlyKeys(raw, ['type', 'content'])) {
    return 'not a document';
  }
  const top = raw['content'];
  if (top !== undefined && !Array.isArray(top)) return 'not a document';
  const stack: { node: unknown; depth: number }[] = ((top ?? []) as unknown[]).map((node) => ({
    node,
    depth: 1,
  }));
  let seen = 0;
  let words = false;
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    seen += 1;
    if (seen > SECTION_DOC_MAX_NODES) return `at most ${SECTION_DOC_MAX_NODES} parts of text`;
    if (depth > SECTION_DOC_MAX_DEPTH) return `nested at most ${SECTION_DOC_MAX_DEPTH} deep`;
    if (!isObject(node) || !onlyKeys(node, NODE_KEYS)) return 'malformed text';
    const { type, text, attrs, marks, content } = node;
    if (typeof type !== 'string' || !NODES.includes(type)) {
      return `a "${String(type).slice(0, 40)}" cannot be part of this text`;
    }
    if (attrs !== undefined && !isObject(attrs)) return 'malformed text';
    if (content !== undefined && !Array.isArray(content)) return 'malformed text';
    if (type === 'text') {
      if (typeof text !== 'string' || content !== undefined) return 'malformed text';
      if (text.trim() !== '') words = true;
    } else if (text !== undefined || marks !== undefined) {
      return `a "${type}" holds no text or marks of its own`;
    }
    if (type === 'heading' && !LEVELS.includes(attrs?.['level'])) {
      return 'a heading is level 2, 3 or 4';
    }
    if (type === 'codeBlock') {
      const lang = attrs?.['language'];
      if (
        lang !== undefined &&
        lang !== null &&
        !(typeof lang === 'string' && CODE_LANGUAGE.test(lang))
      ) {
        return 'a code block’s language is a short name';
      }
    }
    if (marks !== undefined) {
      if (!Array.isArray(marks)) return 'malformed text';
      for (const mark of marks as unknown[]) {
        if (!isObject(mark) || !onlyKeys(mark, MARK_KEYS)) return 'malformed text';
        const markAttrs = mark['attrs'];
        if (markAttrs !== undefined && !isObject(markAttrs)) return 'malformed text';
        if (typeof mark['type'] !== 'string' || !MARKS.includes(mark['type'])) {
          return `"${String(mark['type']).slice(0, 40)}" is not a formatting this text takes`;
        }
        if (mark['type'] === 'link' && !sectionHrefKept(markAttrs?.['href'])) {
          return 'a link goes to a web address (https://…), a page of this site, an email (mailto:) or a phone (tel:)';
        }
      }
    }
    for (const child of (content ?? []) as unknown[]) {
      stack.push({ node: child, depth: depth + 1 });
    }
  }
  return words ? null : 'write some text';
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
