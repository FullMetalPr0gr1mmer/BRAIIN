import { z } from 'zod';
import { isCalendarDay } from './audit';

// Page visibility (Admin v2 U14a): what the admin sends to `PUT /api/admin/page-visibility`,
// one page's or one template's setting. The database holds the same rules (0057's CHECKs and
// guard trigger); the route checks them first so an editor reads a sentence, not a code.
//
// Dates are Riyadh days (`YYYY-MM-DD`, the admin's clock, Asia/Riyadh, UTC+3 all year: no
// daylight saving), stored as the instant of that day's midnight in Riyadh (decision D4).
// "Hide from" is the first hidden day; "Show again on" the first day it is visible again.

export const VISIBILITY_MODES = ['public', 'hidden', 'link'] as const;
export const VisibilityModeSchema = z.enum(VISIBILITY_MODES);
export type VisibilityModeInput = z.infer<typeof VisibilityModeSchema>;

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
    mode: VisibilityModeSchema,
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
