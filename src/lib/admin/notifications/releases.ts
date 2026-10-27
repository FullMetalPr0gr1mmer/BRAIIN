import { ReleaseAreaSchema } from '@schemas/release';
import { publishableAreas } from '@/lib/release/caps';
import { FAILURE_NEXT, failureWords } from '@/lib/release/failureCopy';
import { clockFor } from '../relTime';
import { PER_SOURCE, windowStart, type NotificationSource, type SourceItem } from './types';

// "A scheduled release could not go live" (Admin v2 R11, releases.md §4.7 "Failure"): for the
// people who could publish it again, the roles that publish one of its areas (P-2, from
// ROLE_CAPS through `publishableAreas`: Sales and anon never). ONE read of the tenant's failed
// releases in the bell's window, through the caller's RLS-bound client (content_releases is CMS
// staff's, 0038), and never the release's changes: its time, its areas and its failure code,
// worded by src/lib/release/failureCopy.ts. The item is new from when it failed (the release's
// `updated_at`, stamped by fail_scheduled_release), so a failure after the person last marked
// the bell read lights it. Since R13 it links to Backups & versions, which lists failed releases
// with Review.
//
// Releases are off for every tenant until R14, so no release is ever failed and the read answers
// nothing.

interface FailedRow {
  id: string;
  scheduled_for: string | null;
  areas: unknown;
  failure_code: unknown;
  updated_at: string;
}

export const releases: NotificationSource = {
  kind: 'releases',
  visible: (role) => publishableAreas(role).length > 0,
  async load({ sb, auth, now, tz }) {
    const { data, error } = await sb
      .from('content_releases')
      .select('id,scheduled_for,areas,failure_code:failure->>code,updated_at')
      .eq('tenant_id', auth.tenantId)
      .eq('status', 'failed')
      .gte('updated_at', windowStart(now))
      .order('updated_at', { ascending: false })
      .limit(PER_SOURCE);
    if (error) throw new Error(`notifications (releases): ${error.message}`);
    const mine = new Set<string>(publishableAreas(auth.role));
    const { formatDate, formatTime } = clockFor(tz);
    const items: SourceItem[] = [];
    for (const row of (data ?? []) as unknown as FailedRow[]) {
      const areas = Array.isArray(row.areas)
        ? row.areas.filter((a) => ReleaseAreaSchema.safeParse(a).success)
        : [];
      if (!areas.some((area) => mine.has(String(area)))) continue;
      const planned = row.scheduled_for ? Date.parse(row.scheduled_for) : Number.NaN;
      items.push({
        id: `releases:failed:${row.id}`,
        kind: 'releases',
        icon: 'warn',
        text: Number.isFinite(planned)
          ? `The release scheduled for ${formatDate(planned)}, ${formatTime(planned)} could not go live`
          : 'A scheduled release could not go live',
        detail: `${failureWords(row.failure_code)} ${FAILURE_NEXT}`,
        at: row.updated_at,
        since: row.updated_at,
        href: '/admin/backups',
      });
    }
    return items.slice(0, PER_SOURCE);
  },
};
