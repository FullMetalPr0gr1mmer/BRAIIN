// The studio's time zones (Admin v2 U9), Zod-free so the admin's client code (the clock,
// src/lib/admin/relTime.ts) can import them without the schema library. The settings row's
// schema (./settings.ts) builds its enum from this list.

/**
 * The closed list of the studio's time zones, in the order the select shows them, each
 * labelled by its city. Equal to BOTH database CHECKs, `site_settings_timezone_closed` (0098)
 * and crm_settings' (0035): tests/lib/timeZones.spec.ts parses the migrations and compares.
 */
export const STUDIO_TIME_ZONES = [
  { value: 'Asia/Riyadh', label: 'Riyadh' },
  { value: 'Asia/Dubai', label: 'Dubai' },
  { value: 'Asia/Kuwait', label: 'Kuwait' },
  { value: 'Asia/Qatar', label: 'Doha' },
  { value: 'Asia/Bahrain', label: 'Bahrain' },
  { value: 'Asia/Muscat', label: 'Muscat' },
  { value: 'Africa/Cairo', label: 'Cairo' },
  { value: 'Asia/Amman', label: 'Amman' },
  { value: 'Europe/London', label: 'London' },
  { value: 'UTC', label: 'UTC (no offset)' },
] as const;

export type StudioTimeZone = (typeof STUDIO_TIME_ZONES)[number]['value'];

/** The zone a tenant with no settings row, or an unreadable one, is in. */
export const DEFAULT_TIME_ZONE: StudioTimeZone = 'Asia/Riyadh';

const ZONE_IDS: readonly string[] = STUDIO_TIME_ZONES.map((z) => z.value);

/** True when `value` is one of the studio's zones. */
export function isStudioTimeZone(value: unknown): value is StudioTimeZone {
  return typeof value === 'string' && ZONE_IDS.includes(value);
}

/** A zone's city, as the select and the hints say it ("Riyadh"). */
export function timeZoneCity(zone: string): string {
  return STUDIO_TIME_ZONES.find((z) => z.value === zone)?.label ?? zone;
}
