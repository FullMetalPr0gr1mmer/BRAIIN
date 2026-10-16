import { z } from 'zod';

// The activity log's filters (Admin v2 U13, /admin/audit and its JSON and CSV twins). One
// schema for the page, `GET /api/admin/audit` and `GET /api/admin/audit/export`, so a link
// copied from the page asks the API for the same rows.
//
// The filters are what the client's TDD asks for (§15: "filterable by person, action and
// date"): a kind of activity (the chips), a person, and a range of days in the studio's
// clock (Asia/Riyadh, UTC+3 all year: src/lib/admin/relTime.ts). No free-text search: the
// sentences are composed in TypeScript, so a SQL search over the stored keys would match
// machine words the reader never sees (U13 decision D1).
//
// A GET form sends an empty field as an empty string (`?actor=&from=`), which means "no
// filter", never a refusal.

export const ACTIVITY_KINDS = ['edits', 'publishing', 'leads', 'users', 'settings'] as const;
export const ActivityKindSchema = z.enum(ACTIVITY_KINDS);
export type ActivityKind = z.infer<typeof ActivityKindSchema>;

/** The most pages one filter can be paged to (25 a page): far past any real log. */
export const ACTIVITY_MAX_PAGE = 10_000;

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A calendar day `YYYY-MM-DD` that exists (no 30 February), between 2000 and 2100. */
export function isCalendarDay(value: string): boolean {
  const match = DAY.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 2000 || year > 2100) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/** "" (a blank form field) is no value at all. */
const blankIsAbsent = (value: unknown) => (value === '' ? undefined : value);

const CalendarDay = z
  .string()
  .max(10)
  .refine(isCalendarDay, { message: 'a calendar day, YYYY-MM-DD' });

const filterShape = {
  kind: z.preprocess(blankIsAbsent, ActivityKindSchema.optional()),
  actor: z.preprocess(blankIsAbsent, z.string().uuid().optional()),
  from: z.preprocess(blankIsAbsent, CalendarDay.optional()),
  to: z.preprocess(blankIsAbsent, CalendarDay.optional()),
  // Exact filters a link from one item's history may carry (R10); the page has no control
  // for them. Bounded like the stored values they match.
  entityType: z.preprocess(
    blankIsAbsent,
    z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,59}$/)
      .optional(),
  ),
  entityId: z.preprocess(blankIsAbsent, z.string().max(80).optional()),
};

/** Days picked the wrong way round are read as the range they describe. */
function ordered<T extends { from?: string | undefined; to?: string | undefined }>(value: T): T {
  if (value.from && value.to && value.from > value.to) {
    return { ...value, from: value.to, to: value.from };
  }
  return value;
}

/** The filters alone: what the export takes. */
export const ActivityExportQuerySchema = z.object(filterShape).strict().transform(ordered);
export type ActivityFilters = z.infer<typeof ActivityExportQuerySchema>;

/** The filters and the page: what the page and the JSON route take. */
export const ActivityQuerySchema = z
  .object({
    ...filterShape,
    page: z.preprocess(
      blankIsAbsent,
      z.coerce.number().int().min(1).max(ACTIVITY_MAX_PAGE).default(1),
    ),
  })
  .strict()
  .transform(ordered);
export type ActivityQuery = z.infer<typeof ActivityQuerySchema>;
