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
