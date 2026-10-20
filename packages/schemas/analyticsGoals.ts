import { z } from 'zod';
import { CTA_IDS } from './analytics';

// Website stats goals (Admin v2 G1c): a number the team wants to reach this calendar month,
// counted from the stats rollups (public.goal_progress, migration 0071). Written by holders
// of `analytics.goals` (Admin, SEO; CLAUDE.md §5) through /api/admin/analytics/goals, read by
// every `analytics.read` role. Admin text, English only (the admin is English, L7): not
// public content, so §8's `_ar` rule does not apply. The table's CHECKs say the same
// (analytics_goals in 0071), so a write the Worker would refuse the database refuses too.

/** What a goal can count. Equal to the analytics_goals.metric CHECK (vocabulary spec). */
export const GOAL_METRICS = [
  'visits',
  'pageviews',
  'service_visits',
  'inquiry_visits',
  'cta',
  'interest',
  'inquiries',
] as const;
export type GoalMetric = (typeof GOAL_METRICS)[number];

/** At most this many goals per tenant (the analytics_goals_limit trigger). */
export const MAX_GOALS = 20;
export const GOAL_NAME_MAX = 80;
export const GOAL_TARGET_MAX = 1_000_000;

// No `<`, `>` or C0/C1 control character, as the CHECK (a name is shown as text everywhere,
// but the rule keeps it plain in an export or a log line too).
const PLAIN = /^[^<>\u0000-\u001f\u007f-\u009f]*$/;

const GoalNameSchema = z
  .string()
  .trim()
  .min(1, 'Name the goal')
  .max(GOAL_NAME_MAX, `At most ${GOAL_NAME_MAX} characters`)
  .regex(PLAIN, 'Use letters, numbers and punctuation only');

const goalFields = {
  name: GoalNameSchema,
  metric: z.enum(GOAL_METRICS),
  /** The click a `cta` goal counts; null (or absent) for every other metric. */
  cta: z.enum(CTA_IDS).nullable().optional(),
  target: z
    .number()
    .int('A whole number')
    .min(1, 'At least 1')
    .max(GOAL_TARGET_MAX, `At most ${GOAL_TARGET_MAX.toLocaleString('en-GB')}`),
};

/** A click goal names its click; no other goal names one. */
function pairing(
  value: { metric: GoalMetric; cta?: string | null | undefined },
  ctx: z.RefinementCtx,
) {
  const named = value.cta !== null && value.cta !== undefined;
  if (value.metric === 'cta' && !named) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cta'], message: 'Choose the click' });
  }
  if (value.metric !== 'cta' && named) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['cta'],
      message: 'Only a click goal names a click',
    });
  }
}

/** A new goal. */
export const GoalCreateSchema = z.object(goalFields).strict().superRefine(pairing);

/**
 * A goal changed: the whole goal again (the drawer always sends every field, so the pairing
 * rule is checked on what will be stored), with the version it was read at (409 otherwise).
 */
export const GoalUpdateSchema = z
  .object({ ...goalFields, version: z.number().int().min(1) })
  .strict()
  .superRefine(pairing);

export type GoalCreate = z.infer<typeof GoalCreateSchema>;
export type GoalUpdate = z.infer<typeof GoalUpdateSchema>;
