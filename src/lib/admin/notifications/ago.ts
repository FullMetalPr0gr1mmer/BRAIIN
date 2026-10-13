// "5 minutes ago", "in 3 hours", "yesterday": when a bell item happened, relative to now.
// Pure, for the drawer (in the browser) and the no-JS page (on the server) alike. British
// English, as the rest of the admin.

const UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

const RELATIVE = new Intl.RelativeTimeFormat('en-GB', { numeric: 'auto' });

export function agoLabel(at: string, now: number): string {
  const time = Date.parse(at);
  if (!Number.isFinite(time)) return '';
  const seconds = Math.round((time - now) / 1000);
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return RELATIVE.format(Math.round(seconds / size), unit);
  }
  return 'just now';
}
