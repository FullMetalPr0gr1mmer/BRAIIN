import { ADMIN_TIME_ZONE } from '../relTime';

// The dashboard's head (Admin v2 U1, ui.md §4 "Head"): "Good morning, Amal", by the hour in
// the studio's time zone (ADMIN_TIME_ZONE, Asia/Riyadh; U9 later reads it from
// site_settings.timezone through the same constant), and "Here is how <site> is doing."
// R13 appends the release part ("Last published 3 h ago (v15)").

const HOUR = new Intl.DateTimeFormat('en-GB', {
  timeZone: ADMIN_TIME_ZONE,
  hour: '2-digit',
  hourCycle: 'h23',
});

/** The hour (0 to 23) on the studio's clock. */
export function studioHour(now: Date): number {
  const hour = Number(HOUR.formatToParts(now).find((p) => p.type === 'hour')?.value);
  return Number.isFinite(hour) ? hour % 24 : 0;
}

/** "morning" before 12, "afternoon" before 17, else "evening". */
export function partOfDay(now: Date): 'morning' | 'afternoon' | 'evening' {
  const hour = studioHour(now);
  return hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
}

/** The first word of the display name, else the e-mail's local part. */
export function firstName(displayName: string | null | undefined, email: string): string {
  const first = (displayName ?? '').trim().split(/\s+/u)[0];
  if (first) return first;
  return email.split('@')[0]?.trim() || 'there';
}

export function greeting(now: Date, displayName: string | null | undefined, email: string): string {
  return `Good ${partOfDay(now)}, ${firstName(displayName, email)}`;
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
