import { DEFAULT_TIME_ZONE } from '@schemas/timeZones';
import { zonedParts } from '@/lib/time/zone';

// The dashboard's head (Admin v2 U1, ui.md §4 "Head"): "Good morning, Amal", by the hour in
// the studio's time zone (`site_settings.timezone` since Admin v2 U9, which the page passes),
// and "Here is how <site> is doing." R13 appends the release part ("Last published 3 h ago
// (v15)").

/** The hour (0 to 23) on the studio's clock. */
export function studioHour(now: Date, tz: string = DEFAULT_TIME_ZONE): number {
  return zonedParts(now, tz).hour;
}

/** "morning" before 12, "afternoon" before 17, else "evening". */
export function partOfDay(
  now: Date,
  tz: string = DEFAULT_TIME_ZONE,
): 'morning' | 'afternoon' | 'evening' {
  const hour = studioHour(now, tz);
  return hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
}

/** The first word of the display name, else the e-mail's local part. */
export function firstName(displayName: string | null | undefined, email: string): string {
  const first = (displayName ?? '').trim().split(/\s+/u)[0];
  if (first) return first;
  return email.split('@')[0]?.trim() || 'there';
}

export function greeting(
  now: Date,
  displayName: string | null | undefined,
  email: string,
  tz: string = DEFAULT_TIME_ZONE,
): string {
  return `Good ${partOfDay(now, tz)}, ${firstName(displayName, email)}`;
}

/** The site's host, from PUBLIC_SITE_URL ("braiinstatiion.com"); the URL itself if unparsable. */
export function siteHost(siteUrl: string): string {
  try {
    return new URL(siteUrl).host || siteUrl;
  } catch {
    return siteUrl;
  }
}

export const subLine = (siteUrl: string): string => `Here is how ${siteHost(siteUrl)} is doing.`;
