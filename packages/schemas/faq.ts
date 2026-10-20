import { z } from 'zod';
import { ContentStatusSchema, UuidSchema } from './primitives';

// The FAQ (Admin v2 U7, migration 0096): one question and its answer, both languages, plain
// text. One shape for the admin's writes and one for the public read; the database states
// the same rules as a CHECK (app.faq_text_ok), the backstop for any other write path.
//
// Plain text, ONE paragraph: no HTML (rendered as a text node, escaped in the JSON-LD), and
// no control character, a newline included, because the band's HTML folds a newline that the
// FAQPage JSON-LD would keep, and the two must say the same thing. Both languages are
// required: the question is the page's and, word for word, the structured data's.

export const FAQ_LIMITS = { question: 200, answer: 1200 } as const;

/** C0 and C1 control characters (the CHECK's \u0001-\u001F and \u007F-\u009F, and NUL). */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** One language's text: trimmed (every Unicode space), 1 to `max` characters, one line. */
const faqLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1, 'required')
    .max(max, `at most ${max} characters`)
    .refine((s) => !CONTROL.test(s), 'one paragraph: no line breaks or control characters');

/** A question or an answer: exactly English and Arabic (an extra key is refused). */
export const FaqTextSchema = (max: number) =>
  z.object({ en: faqLine(max), ar: faqLine(max) }).strict();

const InstantSchema = z.string().datetime({ offset: true }).nullish();

const FaqItemWriteBase = z.object({
  question: FaqTextSchema(FAQ_LIMITS.question),
  answer: FaqTextSchema(FAQ_LIMITS.answer),
  status: ContentStatusSchema.default('draft'),
  scheduledFor: InstantSchema,
  sortOrder: z.number().int().min(-10_000).max(10_000).default(0),
});

export const FaqItemWriteSchema = FaqItemWriteBase;
/** `.partial()` plus a required version (packages/schemas/admin.ts, convention 1). */
export const FaqItemUpdateSchema = FaqItemWriteBase.partial().extend({
  version: z.number().int().min(1),
});

/**
 * A published row as the public loader reads it (anon's column grant: id, question, answer,
 * sort_order). Not strict: a column added later is ignored, never a dropped row.
 */
export const FaqItemRowSchema = z.object({
  id: UuidSchema,
  question: z.object({ en: z.string().min(1), ar: z.string().min(1) }),
  answer: z.object({ en: z.string().min(1), ar: z.string().min(1) }),
  sort_order: z.number(),
});
export type FaqItemRow = z.infer<typeof FaqItemRowSchema>;

/** One question as the Contact page renders it and the FAQPage JSON-LD names it. */
export interface FaqEntry {
  question: string;
  answer: string;
}
