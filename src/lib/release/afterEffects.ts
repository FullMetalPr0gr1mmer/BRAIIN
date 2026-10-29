import { env as workerEnv } from 'cloudflare:workers';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ApplyResult, PurgeStatus } from '@schemas/release';
import type { AuthContext } from '@/lib/auth/types';
import { writeAudit } from '@/lib/admin/audit';
import { syncRedirectsOfTenant } from '@/lib/admin/redirectSync';
import { rebuildVisibilitySnapshot } from '@/lib/admin/visibilitySync';
import { writeSystemLog } from '@/lib/data/systemLog';
import { COLLAPSE_TAG, purgeTags, type PurgeOptions } from '@/lib/http/purge';
import { CONTACT_COLUMNS, contactFromRow } from '@/lib/maintenance/contact';
import { refreshMaintenanceContact } from '@/lib/maintenance/refresh';
import { serviceClient } from '@/lib/supabase/server';
import { jsonEqual } from './deepEqual';
import { liveDb } from './overlayDb';
import { releaseTags, type SlugLookup, type SlugTable } from './tags';

// What follows a published release (Admin v2 R7; docs/admin-v2/releases.md §4.2 step 7, §5).
// SERVER ONLY. Each step on its own and never fatal: the release is live, so a failure here is
// reported and retried, never thrown (the `runHook` contract of resource.ts).
//
//   1. The edge snapshots, rebuilt AS THE SYSTEM (the service client, scoped to the release's
//      tenant: a documented system-actor exception, like the daily cron's re-syncs; R6's
//      question 2): the redirect map when the release changed a redirect, the page-visibility
//      snapshot when it changed page visibility or renamed or removed a page (the snapshot
//      names pages by slug, so a renamed hidden page would otherwise be public at the edge
//      until the daily re-sync). Whoever published, the rebuild reads the whole tenant: a
//      Content Creator's rename moves a snapshot they cannot edit. And (R14-prep, R7's hand-off
//      from U9) the maintenance page's contact buttons when the release changed the identity's
//      brand, e-mail or WhatsApp number while maintenance is on, as an identity save does at once
//      (src/lib/maintenance/refresh.ts: the edge's value first, nothing more while it says off).
//   2. The purge (src/lib/http/purge.ts) of the release's tags (src/lib/release/tags.ts).
//   3. The outcome on the release (`record_release_purge`, 0051): its status, its tags, and for
//      a failure when the minute cron tries again (src/lib/cron/releases.ts).
//   4. When a purge was sent: an audit row, `release.purge`, as the publisher (counts and codes,
//      never a tag's value beyond what the release's own audit row already names).
//
// A scheduled release the minute cron fires (R11, `afterFire`) has no publisher's request: the
// same steps run as the system, its slugs read with the service client scoped to the release's
// tenant (no publisher's RLS to read them under), and no audit row for the purge (the cron is no
// person: system_logs, as R7's retries); the release's own `release.publish` row names its
// scheduler, written by the apply.

type Item = ApplyResult['items'][number];

/** Attempts at a release's purge before the cron gives up (0103's claim holds the same). */
export const RELEASE_PURGE_MAX_ATTEMPTS = 10;

/** The identity's columns the maintenance page's buttons show (src/lib/maintenance/contact.ts). */
const CONTACT_KEYS = CONTACT_COLUMNS.split(',');

/** What a release owes the edge after it goes live. */
export interface SnapshotNeeds {
  redirects: boolean;
  visibility: boolean;
  /**
   * The release changed the identity's contact columns (or its items are not known): the
   * maintenance page's buttons follow while maintenance is on. `row` is the identity as the
   * release left it (its after-image), null when not known (read then).
   */
  maintenance?: { row: Record<string, unknown> | null };
}

/** Which edge snapshots a release moves; every one when its items are not known. */
export function snapshotNeeds(items: readonly Item[] | null): SnapshotNeeds {
  if (items === null) return { redirects: true, visibility: true, maintenance: { row: null } };
  let redirects = false;
  let visibility = false;
  let maintenance: SnapshotNeeds['maintenance'];
  for (const item of items) {
    if (item.entity_type === 'redirect') redirects = true;
    if (item.entity_type === 'page_visibility') visibility = true;
    if (item.entity_type === 'site_profile') {
      const before = 'before' in item ? item.before : null;
      const after = 'after' in item ? item.after : null;
      if (CONTACT_KEYS.some((key) => !jsonEqual(before?.[key], after?.[key]))) {
        maintenance = { row: after ?? null };
      }
    }
    if (item.entity_type === 'page') {
      if (item.op === 'delete') visibility = true;
      const before = 'before' in item ? item.before : null;
      const after = 'after' in item ? item.after : null;
      if (item.op === 'update' && before?.['slug'] !== after?.['slug']) visibility = true;
    }
  }
  return maintenance ? { redirects, visibility, maintenance } : { redirects, visibility };
}

/**
 * Rebuilds the snapshots the release moved, as the system. Undefined when none was needed;
 * otherwise whether the edge took every one of the redirect map and the visibility rules (what
 * the publish answer's `kvSynced` reports, and the dialog's "Sync to edge" advice fixes). The
 * maintenance page's buttons are refreshed too but never counted there: a miss is logged and
 * the 10-minute reconcile heals it, and Sync to edge would not (R14-prep review C4).
 */
export async function rebuildSnapshots(
  tenantId: string,
  needs: SnapshotNeeds,
): Promise<boolean | undefined> {
  let kvSynced: boolean | undefined;
  if (needs.redirects) {
    kvSynced = (await syncRedirectsOfTenant(serviceClient(), tenantId)).kvSynced;
  }
  if (needs.visibility) {
    let synced = false;
    try {
      synced = (await rebuildVisibilitySnapshot(serviceClient(), tenantId)).kvSynced;
    } catch (err) {
      void writeSystemLog({
        level: 'error',
        source: 'release:snapshot',
        message: err instanceof Error ? err.message : 'page visibility rebuild failed',
        detail: { tenantId },
      });
    }
    kvSynced = (kvSynced ?? true) && synced;
  }
  if (needs.maintenance) {
    // As the system (the settings row; the identity when the release's image is not known).
    const refreshed = await refreshMaintenanceContact({
      sb: serviceClient(),
      tenantId,
      env: workerEnv,
      contact: needs.maintenance.row ? contactFromRow(needs.maintenance.row) : undefined,
    });
    if (refreshed === 'not-refreshed') {
      void writeSystemLog({
        level: 'warn',
        source: 'release:snapshot',
        message:
          "The maintenance page's contact buttons were not refreshed; the 10-minute reconcile does it.",
        detail: { tenantId },
      });
    }
  }
  return kvSynced;
}

/**
 * Slugs read as the system (a scheduled release the cron fired, R11): the service client, the
 * release's tenant only, one request per table asked (at most the four of SLUG_TABLES).
 */
export function systemSlugs(tenantId: string): SlugLookup {
  return async (reads) => {
    const svc = serviceClient();
    const answers = await Promise.all(
      reads.map(({ table, ids }) =>
        svc
          .from(table)
          .select('id,slug')
          .eq('tenant_id', tenantId)
          .in('id', [...ids]),
      ),
    );
    const out = new Map<SlugTable, Map<string, string>>();
    reads.forEach(({ table }, index) => {
      const { data, error } = answers[index]!;
      if (error) throw new Error(`read ${table} slugs: ${error.message}`);
      const slugs = out.get(table) ?? new Map<string, string>();
      for (const row of (data ?? []) as Record<string, unknown>[]) {
        if (typeof row['slug'] === 'string') slugs.set(String(row['id']), row['slug']);
      }
      out.set(table, slugs);
    });
    return out;
  };
}

/** Slugs read as the publisher, every table in one request (public.release_read_rows, 0103). */
export function publisherSlugs(sb: SupabaseClient, auth: AuthContext): SlugLookup {
  return async (reads) => {
    const answers = await liveDb(sb, auth).listMany(
      reads.map(({ table, ids }) => ({
        table,
        query: { columns: 'id,slug', in: { id: [...ids] } },
      })),
    );
    const out = new Map<SlugTable, Map<string, string>>();
    reads.forEach(({ table }, index) => {
      const slugs = out.get(table) ?? new Map<string, string>();
      for (const row of answers[index] ?? []) {
        if (typeof row['slug'] === 'string') slugs.set(String(row['id']), row['slug']);
      }
      out.set(table, slugs);
    });
    return out;
  };
}

/** When the cron may try a failed purge again: 1, 2, 4… minutes (at most 60), jittered. */
export function purgeRetryAt(
  attempts: number,
  now: number = Date.now(),
  random: () => number = Math.random,
): string | null {
  if (attempts >= RELEASE_PURGE_MAX_ATTEMPTS) return null;
  const capMinutes = Math.min(60, 2 ** Math.max(0, attempts - 1));
  const minutes = capMinutes * (0.5 + 0.5 * random());
  return new Date(now + Math.round(minutes * 60_000)).toISOString();
}

/** The release's purge as recorded: `record_release_purge`, logged when it cannot be written. */
export async function recordPurge(args: {
  tenantId: string;
  releaseId: string;
  status: PurgeStatus;
  tags: readonly string[] | null;
  nextAt: string | null;
  sideEffects: Record<string, unknown>;
}): Promise<boolean> {
  try {
    const { error } = await serviceClient().rpc('record_release_purge', {
      p_tenant: args.tenantId,
      p_release: args.releaseId,
      p_status: args.status,
      p_tags: args.tags === null ? null : [...args.tags].slice(0, 100),
      p_next_at: args.nextAt,
      p_side_effects: args.sideEffects,
    });
    if (error) throw new Error(error.message);
    return true;
  } catch (err) {
    void writeSystemLog({
      level: 'error',
      source: 'release:purge',
      message: err instanceof Error ? err.message : 'record_release_purge failed',
      detail: { releaseId: args.releaseId },
    });
    return false;
  }
}

export interface AfterPublishResult {
  purge: PurgeStatus;
  /** Present when a snapshot was rebuilt: did the edge take every one. */
  kvSynced?: boolean;
  tags: string[];
}

/**
 * Everything after a publish, as above. `items` are the apply's answer; null when it is not
 * known (an apply that committed after the Worker stopped waiting): every snapshot is rebuilt
 * and the whole site purged.
 */
export async function afterPublish(args: {
  sb: SupabaseClient;
  auth: AuthContext;
  releaseId: string;
  number: number;
  items: readonly Item[] | null;
  purge?: Partial<Omit<PurgeOptions, 'source'>>;
}): Promise<AfterPublishResult> {
  const { sb, auth, releaseId, number } = args;
  return runAfterEffects({
    tenantId: auth.tenantId,
    releaseId,
    number,
    items: args.items,
    slugs: publisherSlugs(sb, auth),
    ...(args.purge ? { purge: args.purge } : {}),
    // A purge was sent: its row in the activity log, in its own words (auditLabels).
    onSent: async (outcome) => {
      await writeAudit(sb, auth, {
        action: 'release.purge',
        entityType: 'release',
        entityId: releaseId,
        detail: {
          number,
          status: outcome.status,
          tags: outcome.tags.length,
          ...(outcome.reason ? { reason: outcome.reason } : {}),
        },
      });
    },
  });
}

/**
 * Everything after a scheduled release went live (R11, the minute cron): the same steps as a
 * publish's, as the system (above). Never throws but where a step's own helper does not.
 */
export async function afterFire(args: {
  tenantId: string;
  releaseId: string;
  number: number;
  items: readonly Item[] | null;
  purge?: Partial<Omit<PurgeOptions, 'source'>>;
}): Promise<AfterPublishResult> {
  return runAfterEffects({ ...args, slugs: systemSlugs(args.tenantId) });
}

/** The steps both share: the snapshots, the purge, its record, and `onSent` when one was sent. */
async function runAfterEffects(args: {
  tenantId: string;
  releaseId: string;
  number: number;
  items: readonly Item[] | null;
  slugs: SlugLookup;
  purge?: Partial<Omit<PurgeOptions, 'source'>>;
  onSent?: (outcome: Awaited<ReturnType<typeof purgeTags>>) => Promise<void>;
}): Promise<AfterPublishResult> {
  const { tenantId, releaseId, number, items } = args;
  const kvSynced = await rebuildSnapshots(tenantId, snapshotNeeds(items));

  const { tags } = items === null ? { tags: [COLLAPSE_TAG] } : await releaseTags(items, args.slugs);
  const outcome = await purgeTags(tenantId, tags, { source: 'release', ...args.purge });
  const nextAt =
    outcome.status === 'failed'
      ? purgeRetryAt(1, (args.purge?.now ?? Date.now)(), args.purge?.random ?? Math.random)
      : null;

  if (outcome.status === 'skipped') {
    void writeSystemLog({
      level: 'info',
      source: 'release:purge',
      message: 'No cache zone yet (KAN-20): nothing to purge.',
      detail: { releaseId, number },
    });
  } else if (outcome.status === 'failed') {
    void writeSystemLog({
      level: 'warn',
      source: 'release:purge',
      message: `The cache purge did not go through (${outcome.reason ?? 'unknown'}); the minute cron tries again.`,
      detail: { releaseId, number, reason: outcome.reason ?? null, tags: outcome.tags.length },
    });
  }
  await recordPurge({
    tenantId,
    releaseId,
    status: outcome.status,
    tags: outcome.tags.length > 0 ? outcome.tags : tags,
    nextAt,
    sideEffects: kvSynced === undefined ? {} : { kvSynced },
  });
  if ((outcome.requests > 0 || outcome.status === 'done') && args.onSent) {
    await args.onSent(outcome);
  }
  return kvSynced === undefined
    ? { purge: outcome.status, tags: outcome.tags }
    : { purge: outcome.status, kvSynced, tags: outcome.tags };
}
