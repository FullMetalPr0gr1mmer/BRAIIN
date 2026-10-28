import type { Clock } from '@/lib/admin/relTime';
import type { ReleaseArea } from '@schemas/release';
import type { VersionSummary } from '@/lib/release/versions';
import { FAILURE_NEXT, failureWords } from '@/lib/release/failureCopy';
import { AREA_WORDS } from '@/components/admin/screens/release/model';

// Backups & versions' words and rules (Admin v2 R13; releases.md §7 "Versions page", P-12:
// plain, warm, no dashes). Pure, so tests/lib/versionsPage.spec.ts holds every line and the kit
// gallery draws the same list over made-up versions. The server decides every action; nothing
// here is a gate.

export type { VersionSummary } from '@/lib/release/versions';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "v12": how a version is named everywhere in the admin. */
export const versionName = (number: number | null) =>
  number === null ? 'A release' : `v${number}`;

/** "{k} changes in Pages and Services" (releases.md §7). */
export function changesLine(version: Pick<VersionSummary, 'itemCount' | 'areas'>): string {
  const areas = version.areas
    .filter((a): a is ReleaseArea => Object.hasOwn(AREA_WORDS, a))
    .map((a) => AREA_WORDS[a]);
  const where =
    areas.length === 0
      ? ''
      : areas.length === 1
        ? ` in ${areas[0]}`
        : ` in ${areas.slice(0, -1).join(', ')} and ${areas[areas.length - 1]}`;
  return `${plural(version.itemCount, 'change')}${where}`;
}

/** What kind of version it is, when it is not a plain publish. */
export function kindLine(version: Pick<VersionSummary, 'kind' | 'restores'>): string | null {
  if (version.kind === 'rollback') {
    return version.restores === null
      ? 'Restored an earlier version'
      : `Restored v${version.restores}`;
  }
  if (version.kind === 'baseline') return 'The site as it was when publishing in releases began';
  if (version.kind === 'legacy_schedule') return 'Scheduled before publishing in releases began';
  return null;
}

/** "by Amal · 12 Oct 2026, 14:05". */
export function byLine(name: string | null | undefined, at: string | null, clock: Clock): string {
  const who = name ? `by ${name}` : null;
  const when = at ? clock.formatDateTime(at) : null;
  return [who, when].filter(Boolean).join(' · ');
}

/** "12 Oct 2026, 14:00 (Riyadh time)": when a scheduled release goes live, beside its badge. */
export function scheduledTitle(at: string | null, clock: Clock, zone: string): string {
  return at ? `${clock.formatDateTime(at)} (${zone})` : 'No time set';
}

/** "Couldn't publish on 12 Oct 2026, 14:00: {reason} Its changes are waiting to be published again." */
export function failedLine(
  version: Pick<VersionSummary, 'scheduledFor' | 'failure'>,
  clock: Clock,
): string {
  const when = version.scheduledFor ? ` on ${clock.formatDateTime(version.scheduledFor)}` : '';
  return `Couldn’t publish${when}: ${failureWords(version.failure)} ${FAILURE_NEXT}`;
}

/** The website cache's state for a version (R7), or null when there is nothing to say. */
export function purgeLine(purge: string): { text: string; retry: boolean } | null {
  if (purge === 'failed') return { text: 'Couldn’t refresh the website cache.', retry: true };
  if (purge === 'pending') return { text: 'Refreshing the website cache…', retry: false };
  return null;
}

export const COPY = {
  restoreTitle: (n: number) => `Restore v${n}?`,
  restoreBody:
    'This version’s content comes back as unpublished changes for you to review. Nothing goes live until you publish, and the current version stays in the list.',
  restored: (n: number) => `v${n} restored. Publish to make it live.`,
  restoredWaiting: (k: number) =>
    `Restored as ${plural(k, 'unpublished change')}. Nothing is live until it is published.`,
  restoredOthers:
    'This version was restored. Some of its changes are ones your role can’t publish, so someone who can publish all of them makes it live.',
  restoredEdited:
    'These restored changes now publish as an ordinary release, from the bar at the bottom of the screen.',
  publishAgain: (n: number) => `Publish v${n} again`,
  publishAgainBody: (n: number, k: number) =>
    `Publish v${n} again? Its ${plural(k, 'change')} go live together as a new version.`,
  publishAgainRefused:
    'Some of these changes can’t be published as they stand. Open Publish to see which, and why.',
  unscheduleBody: (k: number) =>
    `Unschedule this release? Its ${plural(k, 'change')} stay as unpublished changes, unlocked, for anyone who can publish them.`,
  unscheduled: 'Unscheduled. Its changes are waiting to be published.',
  moved: (at: string) => `Moved to ${at}.`,
  changeTime: 'Change time',
  changeTimeSub: 'It goes live at this day and time, on the studio’s clock.',
  purgeDone: 'The website cache was refreshed.',
  purgeSkipped: 'No website cache is connected yet, so the site already shows this version.',
  failedRetry: 'Review',
  noVersions: 'No version has been published yet.',
  forbidden: 'Your role can’t publish all of this. Ask an Admin.',
} as const;

/** A restore refusal's items, named for the person ("Logo Design", or the type in words). */
export function refusedNames(body: Readonly<Record<string, unknown>>): string[] {
  const items = Array.isArray(body['items']) ? (body['items'] as Record<string, unknown>[]) : [];
  const out: string[] = [];
  for (const item of items) {
    const label = item['label'] as Record<string, unknown> | null | undefined;
    const name =
      (typeof label?.['en'] === 'string' && label['en'].trim()) ||
      (typeof label?.['ar'] === 'string' && label['ar'].trim()) ||
      String(item['entityType'] ?? 'item').replace(/_/g, ' ');
    if (!out.includes(name)) out.push(name);
  }
  return out;
}
