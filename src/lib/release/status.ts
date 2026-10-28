import type { PendingItem, ReleaseStatusAnswer } from '@schemas/release';
import { PurgeStatusSchema } from '@schemas/release';
import type { AdminRouteContext } from '@/lib/admin/route';
import { purgeConfig } from '@/lib/http/purge';
import { buildRows, savebarCounts } from '@/components/admin/screens/release/model';
import { pendingSummary } from './draftEndpoints';
import { namesOf } from './versions';

// The dashboard's "Publish status" card (Admin v2 R13; docs/admin-v2/releases.md §7). SERVER
// ONLY. `GET /api/admin/releases/status` answers, for a CMS role that reads a release-managed
// area (the pending summary's gate, never Sales):
//
//   live       the version the site shows now: its number, when and by whom, its note, and how
//              its cache purge went (R7: done, skipped with no zone, pending, failed);
//   pending    the pending changes as the savebar counts them (R12's `buildRows` and
//              `savebarCounts` over R3b's summary: mine to publish, waiting for someone who
//              can, locked by a schedule; a reordered list once), so the card and the bar never
//              disagree;
//   next       the next scheduled release (its time and how many changes) and how many are
//              scheduled;
//   failed     scheduled releases that could not go live in the last 7 days (the window the
//              dashboard's `release_failed` row uses, 0066);
//   cacheConnected  whether a cache zone is set up (O-3): until then "Not connected yet";
//   maintenance     the switch as the edge holds it (one KV read, failing open to off as the
//                   middleware does), null only if that read throws.
//
// Every read is the person's own (RLS: the ledger and the drafts are CMS staff's, 0038), scoped
// to their tenant. Releases off (every tenant until R14): only the flag is read, and the answer
// says `enabled: false` with nothing else, so the card is never drawn from it.

type Ctx = AdminRouteContext<unknown>;
type Row = Record<string, unknown>;

/** The failed-release window, as `dashboard_attention`'s `release_failed` kind (0066). */
export const FAILED_WINDOW_DAYS = 7;

const OFF: ReleaseStatusAnswer = {
  enabled: false,
  live: null,
  pending: { publishable: 0, waiting: 0, scheduled: 0 },
  next: null,
  failed: 0,
  cacheConnected: false,
  maintenance: null,
};

/** `GET /api/admin/releases/status`. `maintenance` reads the edge's switch (the route's KV). */
export async function releaseStatus(
  ctx: Ctx,
  maintenance: () => Promise<boolean | null>,
  now: number = Date.now(),
): Promise<ReleaseStatusAnswer> {
  const { sb, auth } = ctx;
  if (!(await ctx.releasesEnabled())) return OFF;
  const since = new Date(now - FAILED_WINDOW_DAYS * 86_400_000).toISOString();
  const [live, next, failed, summary, names, onNow] = await Promise.all([
    sb
      .from('content_releases')
      .select('id,number,note,published_at,published_by,purge_status')
      .eq('tenant_id', auth.tenantId)
      .eq('status', 'published')
      .order('number', { ascending: false })
      .limit(1)
      .maybeSingle(),
    sb
      .from('content_releases')
      .select('id,scheduled_for,item_count', { count: 'exact' })
      .eq('tenant_id', auth.tenantId)
      .eq('status', 'scheduled')
      .order('scheduled_for', { ascending: true })
      .limit(1),
    sb
      .from('content_releases')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', auth.tenantId)
      .eq('status', 'failed')
      .gte('updated_at', since),
    pendingSummary(ctx),
    namesOf(sb, auth),
    maintenance().catch(() => null),
  ]);
  if (live.error) throw new Error(`read the live version: ${live.error.message}`);
  if (next.error) throw new Error(`read scheduled releases: ${next.error.message}`);
  if (failed.error) throw new Error(`read failed releases: ${failed.error.message}`);

  const row = live.data as Row | null;
  const by = row && typeof row['published_by'] === 'string' ? row['published_by'] : null;
  const counts = savebarCounts(buildRows((summary['items'] ?? []) as PendingItem[]));
  const first = ((next.data ?? []) as Row[])[0];
  return {
    enabled: true,
    live:
      row && typeof row['number'] === 'number'
        ? {
            id: String(row['id']),
            number: row['number'],
            publishedAt: typeof row['published_at'] === 'string' ? row['published_at'] : null,
            publishedBy: by ? { id: by, name: names.get(by) ?? null } : null,
            note: typeof row['note'] === 'string' ? row['note'] : null,
            purge: PurgeStatusSchema.catch('pending').parse(row['purge_status']),
          }
        : null,
    pending: {
      publishable: counts.publishable,
      waiting: counts.waiting,
      scheduled: counts.scheduled,
    },
    next:
      first && typeof first['scheduled_for'] === 'string'
        ? {
            id: String(first['id']),
            scheduledFor: first['scheduled_for'],
            changes: typeof first['item_count'] === 'number' ? first['item_count'] : 0,
            total: Math.max(1, next.count ?? 1),
          }
        : null,
    failed: failed.count ?? 0,
    cacheConnected: purgeConfig() !== null,
    maintenance: onNow,
  };
}
