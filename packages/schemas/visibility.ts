import { z } from 'zod';
import { isCalendarDay } from './audit';
import { HELP_FORBIDDEN } from './help';

// Page visibility (Admin v2 U14a): what the admin sends to `PUT /api/admin/page-visibility`,
// one page's or one template's setting. The database holds the same rules (0057's CHECKs and
// guard trigger); the route checks them first so an editor reads a sentence, not a code.
//
// Dates are Riyadh days (`YYYY-MM-DD`, the admin's clock, Asia/Riyadh, UTC+3 all year: no
// daylight saving), stored as the instant of that day's midnight in Riyadh (decision D4).
// "Hide from" is the first hidden day; "Show again on" the first day it is visible again.

/** Every mode `page_visibility.mode` knows (0057, widened by 0061). */
export const VISIBILITY_MODES = ['public', 'hidden', 'link', 'password'] as const;
export const VisibilityModeSchema = z.enum(VISIBILITY_MODES);
export type VisibilityModeInput = z.infer<typeof VisibilityModeSchema>;

/**
 * The modes `PUT /api/admin/page-visibility` takes. `password` is not one: a password goes
 * through its own door, `POST /api/admin/page-visibility/password`, which hands it to
 * `public.set_page_password` and never stores or echoes it (Admin v2 U14b). A save that
 * named `password` here would have no password to set.
 */
export const VISIBILITY_WRITE_MODES = ['public', 'hidden', 'link'] as const;
export const VisibilityWriteModeSchema = z.enum(VISIBILITY_WRITE_MODES);

const RiyadhDay = z
  .string()
  .max(10)
  .refine(isCalendarDay, { message: 'a calendar day, YYYY-MM-DD' });

/** A Riyadh day → the instant its midnight is, as the database stores it. */
export function riyadhMidnight(day: string): string {
  return new Date(`${day}T00:00:00+03:00`).toISOString();
}

/** An instant → the Riyadh day it falls on (`YYYY-MM-DD`), for the drawer's date fields. */
export function riyadhDayOf(instant: string): string | null {
  const ms = Date.parse(instant);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export const VisibilityTargetSchema = z.union([
  z.object({ pageId: z.string().uuid() }).strict(),
  z.object({ template: z.enum(['service', 'case_study']) }).strict(),
]);

export const PageVisibilityWriteSchema = z
  .object({
    target: VisibilityTargetSchema,
    mode: VisibilityWriteModeSchema,
    /** A hidden page's redirect (another page's id), or null for a "page not found". */
    redirectPageId: z.string().uuid().nullable().default(null),
    hideFrom: RiyadhDay.nullable().default(null),
    showOn: RiyadhDay.nullable().default(null),
    /** The version the drawer read; 0 for a page or template that has no row yet. */
    version: z.number().int().min(0),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.mode !== 'hidden') {
      for (const key of ['redirectPageId', 'hideFrom', 'showOn'] as const) {
        if (value[key] !== null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: 'Only a hidden page takes a redirect or dates.',
          });
        }
      }
    }
    if (value.hideFrom && value.showOn && value.showOn <= value.hideFrom) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['showOn'],
        message: 'Show again on must be after Hide from.',
      });
    }
    if ('template' in value.target && value.mode === 'link') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mode'],
        message: 'A template is either visible or hidden.',
      });
    }
  });
export type PageVisibilityWrite = z.infer<typeof PageVisibilityWriteSchema>;

// ---- the password mode (U14b) ---------------------------------------------------------

/** What bcrypt reads, and what 0061's `set_page_password` refuses outside. */
export const PAGE_PASSWORD_BYTES = { min: 8, max: 72 } as const;

/** The longest line the gate shows above the box, per language (0061's CHECK). */
export const PAGE_NOTE_MAX = 140;

const noteLine = z
  .string()
  .max(PAGE_NOTE_MAX)
  .refine((s) => /\S/.test(s), 'empty')
  .refine((s) => !HELP_FORBIDDEN.test(s), 'no markup or control characters');

/**
 * The line above the password box, in either language or both. Plain text: the gate page
 * renders it escaped, and the database refuses `<`, `>` and control characters too.
 */
export const PageNoteSchema = z
  .object({ en: noteLine.optional(), ar: noteLine.optional() })
  .strict()
  .refine((v) => v.en !== undefined || v.ar !== undefined, {
    message: 'Write the message in English, in Arabic, or in both.',
  });
export type PageNote = z.infer<typeof PageNoteSchema>;

/** A password is measured in BYTES, as bcrypt reads it, not in characters. */
export const passwordBytes = (value: string): number => new TextEncoder().encode(value).length;

/**
 * `POST /api/admin/page-visibility/password`: one page, one password, one optional message.
 * The password is never stored by the Worker, never logged and never sent back.
 */
export const PagePasswordWriteSchema = z
  .object({
    pageId: z.string().uuid(),
    password: z
      .string()
      .max(200)
      .refine(
        (v) => passwordBytes(v) >= PAGE_PASSWORD_BYTES.min,
        `A password is at least ${PAGE_PASSWORD_BYTES.min} characters.`,
      )
      .refine(
        (v) => passwordBytes(v) <= PAGE_PASSWORD_BYTES.max,
        `A password is at most ${PAGE_PASSWORD_BYTES.max} bytes.`,
      ),
    note: PageNoteSchema.nullable().default(null),
    /** The version the drawer read; 0 for a page that has no row yet. */
    version: z.number().int().min(0),
  })
  .strict();
export type PagePasswordWrite = z.infer<typeof PagePasswordWriteSchema>;

/** What the unlock form posts (src/pages/api/page-access.ts). Never logged, never echoed. */
export const PAGE_ACCESS_FIELDS = { page: 'page', next: 'next', password: 'password' } as const;
