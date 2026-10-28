import { z } from 'zod';
import { PurgeStatusSchema, type PurgeRetryResult } from '@schemas/release';
import { json, type AdminRouteContext } from '@/lib/admin/route';
import { writeAudit } from '@/lib/admin/audit';
import { RateLimitError } from '@/lib/admin/errors';
import { claimPrivilegedOp, RELEASE_PURGE_LIMITS } from '@/lib/admin/rateLimit';
import { writeSystemLog } from '@/lib/data/systemLog';
import { COLLAPSE_TAG, purgeTags, type PurgeOptions } from '@/lib/http/purge';
import { purgeRetryAt, recordPurge, RELEASE_PURGE_MAX_ATTEMPTS } from './afterEffects';
import { RELEASES_OFF_DETAIL } from './endpoints';

// "Couldn't refresh the website cache · Retry" (Admin v2 R13; docs/admin-v2/releases.md §5.3,
// §7: the dashboard card and the versions page). SERVER ONLY. `POST
// /api/admin/releases/[id]/purge` sends a published version's purge again, by hand: R7 left it to
// R10 and R10 to R7, so it came with the versions screen (as-built R7 and R10, Open).
//
// In order: releases on (else 409 `releases-off`, nothing more read); the version, read under the
// person's RLS (the ledger is CMS staff's, 0038) in their tenant (else 404); published, not the
// switch-on baseline, and its purge `failed` (else 409 `not-owed`: a purge that is done, skipped
// because no cache is set up, pending with the minute cron or not needed has nothing to retry);
// a slot in the privileged-op ledger (`release-purge`, RELEASE_PURGE_LIMITS: 5 an hour per
// person, 10 per tenant; 429 past it, 503 when the ledger cannot be written: fails closed); then
// the tags the version stored, through the one purge seam (src/lib/http/purge.ts: the 24-hour
// budget in the database, the breaker, one retry on a network error).
//
// A press the seam sent nothing for (its breaker open, the budget spent or unreadable) leaves the
// version as it was: 503 with the reason, no record and no audit row, so a press that reached
// no one never counts against the version's ten attempts (review R13-SEC-1: a few such presses
// used to end the cron's retries). Otherwise the outcome is recorded on the version as the cron
// records its retries (`record_release_purge`, which counts the attempt; a failure again is due
// for the cron with the same backoff, none after the tenth, said in `autoRetry` and logged as an
// error, as the cron logs its own last attempt), and every press that changed the row is a
// `release.purge` row in the activity log naming it a retry by hand. Never a write to the site:
// a purge only makes the edge read the live pages again.
//
// A retry and the minute cron can meet on one version (the cron's lease is not checked): both
// send the same tags, which the zone takes twice at no harm (a purge is idempotent), and the
// later record stands. Not live-rechecked: a purge changes nothing a role guards, and the
// kernel's session check already turns away a token whose role no longer matches the profile.

type Row = Record<string, unknown>;
type Ctx = AdminRouteContext<unknown>;

const Uuid = z.string().uuid();

/** The privileged-op ledger's name for a retry by hand. */
export const RELEASE_PURGE_OP = 'release-purge';

export const RETRY_COPY = {
  notOwed: 'This version has nothing to refresh: the website already shows it.',
  limited: 'The website cache has been retried a few times this hour. Try again later.',
  ledger: 'The retry couldn’t start just now. Try again in a few minutes.',
  notSent:
    'The website cache can’t be reached right now, so nothing was sent. Try again in a few minutes.',
} as const;

/** `POST /api/admin/releases/[id]/purge`. */
export async function retryPurge(
  ctx: Ctx,
  options: Partial<Omit<PurgeOptions, 'source'>> = {},
): Promise<PurgeRetryResult | Response> {
  const { sb, auth, params } = ctx;
  if (!(await ctx.releasesEnabled())) {
    return json({ ok: false, error: 'releases-off', detail: RELEASES_OFF_DETAIL }, 409);
  }
  const id = Uuid.safeParse(params['id']);
  if (!id.success) return json({ ok: false, error: 'not-found', entity: 'release' }, 404);
  const { data, error } = await sb
    .from('content_releases')
    .select('id,number,kind,status,tags,purge_status,purge_attempts')
    .eq('tenant_id', auth.tenantId)
    .eq('id', id.data)
    .maybeSingle();
  if (error) throw new Error(`read the version: ${error.message}`);
  const row = data as Row | null;
  if (!row) return json({ ok: false, error: 'not-found', entity: 'release' }, 404);
  const number = typeof row['number'] === 'number' ? row['number'] : null;
  if (
    row['status'] !== 'published' ||
    number === null ||
    row['kind'] === 'baseline' ||
    row['purge_status'] !== 'failed'
  ) {
    return json({ ok: false, error: 'not-owed', detail: RETRY_COPY.notOwed }, 409);
  }

  try {
    await claimPrivilegedOp(auth, RELEASE_PURGE_OP, RELEASE_PURGE_LIMITS);
  } catch (err) {
    if (!(err instanceof RateLimitError)) throw err;
    if (err.scope.endsWith(':unavailable')) {
      return json({ ok: false, error: 'unavailable', detail: RETRY_COPY.ledger }, 503);
    }
    const response = json(
      { ok: false, error: 'rate-limit', scope: err.scope, detail: RETRY_COPY.limited },
      429,
    );
    response.headers.set('retry-after', String(RELEASE_PURGE_LIMITS.windowMinutes * 60));
    return response;
  }

  const stored = Array.isArray(row['tags'])
    ? (row['tags'] as unknown[]).filter((t): t is string => typeof t === 'string')
    : [];
  // A version that kept no tags owes the whole site (the cron's rule for an empty set).
  const tags = stored.length > 0 ? stored : [COLLAPSE_TAG];
  const outcome = await purgeTags(auth.tenantId, tags, { ...options, source: 'release' });
  if (outcome.status === 'failed' && outcome.requests === 0) {
    // Nothing reached the zone: the version stays as it was, for the cron or a later press.
    return json(
      {
        ok: false,
        error: 'purge-not-sent',
        detail: RETRY_COPY.notSent,
        ...(outcome.reason ? { reason: outcome.reason } : {}),
      },
      503,
    );
  }
  const attempts =
    (typeof row['purge_attempts'] === 'number' ? row['purge_attempts'] : 0) +
    (outcome.status === 'not_needed' ? 0 : 1);
  const nextAt =
    outcome.status === 'failed'
      ? purgeRetryAt(attempts, (options.now ?? Date.now)(), options.random ?? Math.random)
      : null;
  await recordPurge({
    tenantId: auth.tenantId,
    releaseId: id.data,
    status: outcome.status,
    tags: null,
    nextAt,
    sideEffects: {},
  });
  await writeAudit(sb, auth, {
    action: 'release.purge',
    entityType: 'release',
    entityId: id.data,
    detail: {
      number,
      status: outcome.status,
      tags: outcome.tags.length,
      retry: true,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
    },
  });
  const autoRetry = outcome.status === 'failed' && nextAt !== null;
  if (outcome.status === 'failed' && !autoRetry) {
    await writeSystemLog({
      level: 'error',
      source: 'release:purge',
      message: `release purge failed ${RELEASE_PURGE_MAX_ATTEMPTS} times and will not be retried`,
      detail: { releaseId: id.data, number, reason: outcome.reason ?? null, retry: true },
    });
  }
  return {
    release: { id: id.data, number },
    purge: PurgeStatusSchema.parse(outcome.status),
    autoRetry,
  };
}
