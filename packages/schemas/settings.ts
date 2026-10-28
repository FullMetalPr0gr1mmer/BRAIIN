import { z } from 'zod';

// The technical settings row, `public.site_settings` (Admin + Developer, `settings.general`;
// staff read it, anon never). Admin v2 U9 (0102) adds the studio's time zone, the one clock
// every admin screen prints in. It is IMMEDIATE (P-3), never part of a release, which is why
// it lives on this row and not on the staged `site_profile` (deviations.md, U9).

import { STUDIO_TIME_ZONES, type StudioTimeZone } from './timeZones';

export {
  DEFAULT_TIME_ZONE,
  STUDIO_TIME_ZONES,
  isStudioTimeZone,
  timeZoneCity,
  type StudioTimeZone,
} from './timeZones';

const ZONE_IDS = STUDIO_TIME_ZONES.map((zone) => zone.value) as [
  StudioTimeZone,
  ...StudioTimeZone[],
];

export const StudioTimeZoneSchema = z.enum(ZONE_IDS);

/**
 * Retention horizons. Bounded, not free-form: retention is a PDPL commitment, and Pillar 4
 * pins raw telemetry at 90 days "pending legal sign-off (may go shorter, never longer)". The
 * ceiling is that promise expressed as a constraint.
 */
export const RETENTION_LIMITS = {
  raw_telemetry_days: { min: 1, max: 90 },
  leads_months: { min: 1, max: 24 },
  spam_days: { min: 1, max: 90 },
} as const;

export const RetentionSchema = z.object({
  raw_telemetry_days: z
    .number()
    .int()
    .min(RETENTION_LIMITS.raw_telemetry_days.min)
    .max(RETENTION_LIMITS.raw_telemetry_days.max)
    .optional(),
  leads_months: z
    .number()
    .int()
    .min(RETENTION_LIMITS.leads_months.min)
    .max(RETENTION_LIMITS.leads_months.max)
    .optional(),
  spam_days: z
    .number()
    .int()
    .min(RETENTION_LIMITS.spam_days.min)
    .max(RETENTION_LIMITS.spam_days.max)
    .optional(),
});

/**
 * Admin write (PATCH /api/admin/settings). `identity` left the form and the schema in U9: the
 * column (`{title, default_locale}`) has had no reader since 0048, and dropping it is a later
 * contract slice. A body that still sends it is refused (strict), so nothing writes it again.
 */
export const SiteSettingsSchema = z
  .object({
    timezone: StudioTimeZoneSchema.optional(),
    retention: RetentionSchema.optional(),
    version: z.number().int().min(0),
  })
  .strict();
export type SiteSettingsInput = z.infer<typeof SiteSettingsSchema>;
