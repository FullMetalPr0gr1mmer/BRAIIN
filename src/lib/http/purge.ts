import { CF_CACHE_PURGE_TOKEN, CF_ZONE_ID } from 'astro:env/server';
import { serviceClient } from '@/lib/supabase/server';
import { outboundJson, OutboundError, type OutboundOptions } from './outbound';

// The ONE module that purges the edge cache (Admin v2 R7; docs/admin-v2/releases.md §5.3;
// CLAUDE.md §2 "Publish = cache event, not a rebuild", "purge by tag only"). SERVER ONLY.
//
// What it purges with: the Cloudflare zone API, by Cache-Tag (`POST /zones/{zone}/purge_cache
// {tags}`, available on every plan; the Free plan allows 5 purge requests a minute). That is
// the backend for a zone cache in front of the Worker. Workers Cache (`wrangler.jsonc`
// `cache`) and Astro's cache provider (`astro.config.mjs` `cache`) would need their own
// backend (`ctx.cache.purge`), and maintenance would have to purge everything when it goes on
// (their hits skip the Worker): neither is built, so tests/lib/cacheLayer.spec.ts refuses
// either while PURGE_BACKENDS lacks it.
//
// Not set up (owner item O-3: no zone and no Zone · Cache Purge token yet; KAN-20): every purge
// is `skipped`, nothing is sent and nothing is read. On *.workers.dev no layer stores a Tier A
// response, so `skipped` still means "the website already shows the change".
//
// The rules (CLAUDE.md §2 and Pillar 4):
//   • at most 30 tags a request; a set of more, or one holding a tag the API cannot take, is
//     purged as `tenant:default`, the tag every Tier A response carries;
//   • at most 30,000 tags in 24 hours across the deployment (one zone): each request is
//     taken from the budget first, in the database (`public.cache_purge_take`, 0103), so the
//     count holds across isolates; when the budget cannot be read the request is not sent
//     (`failed`, retried by the minute cron), never sent blind;
//   • a timeout, one retry on a network error or a 5xx after 200 to 600 ms of jitter
//     (src/lib/http/outbound.ts), never on a 4xx; a 429 is `failed` and retried later;
//   • a breaker in the isolate: three failures in a row stop requests for a minute, so a
//     zone that is down is not hammered by every publish; the minute cron's backoff
//     (src/lib/cron/releases.ts) is the persisted half;
//   • idempotent: purging a tag twice is harmless;
//   • NEVER throws: a purge follows a committed change, so its failure is reported, not
//     raised. Its outcome names a reason code only, never the token or the response body.

/** The cache layers this module can purge. Only the zone's (see above). */
export const PURGE_BACKENDS = ['zone'] as const;

/** Tags one purge request carries at most (CLAUDE.md §2; 0103's cache_purge_log CHECK). */
export const CACHE_PURGE_MAX_TAGS = 30;
/** Tags purged in 24 hours at most, across the deployment (CLAUDE.md §2; 0103). */
export const CACHE_PURGE_DAY_TAGS = 30_000;
/** What a set of more than 30 tags is purged as: every Tier A response carries it. */
export const COLLAPSE_TAG = 'tenant:default';

/** A tag the purge API and `record_release_purge` (0051) both accept: `<kind>:<value>`. */
export const PURGE_TAG = /^[a-z_]+:[a-z0-9_:-]+$/;

/** How long one request may take, and its retries (a publish waits for it). */
export const PURGE_REQUEST: Required<Pick<OutboundOptions, 'timeoutMs' | 'retries'>> = {
  timeoutMs: 1_200,
  retries: 1,
};

/** The breaker: this many failures in a row stop requests from this isolate for a minute. */
export const BREAKER = { failures: 3, openMs: 60_000 } as const;

export type PurgeSource = 'release' | 'cron' | 'media';

export type PurgeReason =
  | 'not-set-up'
  | 'budget'
  | 'budget-unread'
  | 'breaker'
  | 'rate-limited'
  | 'refused'
  | 'http'
  | 'network'
  | 'timeout';

export interface PurgeOutcome {
  /** done: the zone took it; skipped: not set up; failed: try again later; not_needed: no tag. */
  status: 'done' | 'skipped' | 'failed' | 'not_needed';
  /** The tags sent, or that would have been. */
  tags: string[];
  /** Requests to the zone API (subrequests), retries included. */
  requests: number;
  reason?: PurgeReason;
}

export interface PurgeConfig {
  zoneId: string;
  token: string;
}

/** The zone and its token, or null: not set up. */
export function purgeConfig(): PurgeConfig | null {
  const zoneId = (CF_ZONE_ID ?? '').trim();
  const token = (CF_CACHE_PURGE_TOKEN ?? '').trim();
  // A zone id is 32 hex characters; anything else is a misconfiguration, treated as unset.
  if (!/^[0-9a-f]{32}$/.test(zoneId) || token.length === 0) return null;
  return { zoneId, token };
}

/**
 * The tags a purge sends: lower case, each once, in order. More than 30, or any tag the API
 * cannot take (a stray character in a slug), and the set is `tenant:default` alone: purging
 * everything is safe, purging less than the change touched is not. Empty stays empty.
 */
export function purgeTagSet(tags: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim().toLowerCase();
    if (!PURGE_TAG.test(tag)) return [COLLAPSE_TAG];
    if (!out.includes(tag)) out.push(tag);
  }
  return out.length > CACHE_PURGE_MAX_TAGS ? [COLLAPSE_TAG] : out;
}

// ---- the breaker (this isolate) -------------------------------------------------------------

const breaker = { failures: 0, openUntil: 0 };

/** For tests: close the breaker. */
export function resetPurgeBreaker(): void {
  breaker.failures = 0;
  breaker.openUntil = 0;
}

function breakerOpen(now: number): boolean {
  return breaker.openUntil > now;
}

function noteOutcome(ok: boolean, now: number): void {
  if (ok) {
    breaker.failures = 0;
    breaker.openUntil = 0;
    return;
  }
  breaker.failures += 1;
  if (breaker.failures >= BREAKER.failures) breaker.openUntil = now + BREAKER.openMs;
}

// ---- the purge ------------------------------------------------------------------------------

export interface PurgeOptions {
  source: PurgeSource;
  /** Overrides the environment (tests); null is "not set up". */
  config?: PurgeConfig | null;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

/** Takes the tags from the 24-hour budget: true to send, false over budget, null unreadable. */
async function takeBudget(
  tenantId: string,
  count: number,
  source: PurgeSource,
): Promise<boolean | null> {
  try {
    const { data, error } = await serviceClient().rpc('cache_purge_take', {
      p_tenant: tenantId,
      p_tags: count,
      p_source: source,
    });
    if (error || typeof data !== 'boolean') return null;
    return data;
  } catch {
    return null;
  }
}

/** Purges these tags from the zone's cache, for one tenant. Never throws. */
export async function purgeTags(
  tenantId: string,
  tags: readonly string[],
  options: PurgeOptions,
): Promise<PurgeOutcome> {
  const set = purgeTagSet(tags);
  if (set.length === 0) return { status: 'not_needed', tags: [], requests: 0 };
  const config = options.config === undefined ? purgeConfig() : options.config;
  if (!config) return { status: 'skipped', tags: set, requests: 0, reason: 'not-set-up' };
  const now = options.now ?? Date.now;
  if (breakerOpen(now())) return { status: 'failed', tags: set, requests: 0, reason: 'breaker' };

  const budget = await takeBudget(tenantId, set.length, options.source);
  if (budget === null) return { status: 'failed', tags: set, requests: 0, reason: 'budget-unread' };
  if (!budget) return { status: 'failed', tags: set, requests: 0, reason: 'budget' };

  let requests = 0;
  const fetchImpl = options.fetchImpl ?? fetch;
  const counting: typeof fetch = (input, init) => {
    requests += 1;
    return fetchImpl(input, init);
  };
  try {
    const { json } = await outboundJson(
      `https://api.cloudflare.com/client/v4/zones/${config.zoneId}/purge_cache`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.token}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ tags: set }),
      },
      {
        ...PURGE_REQUEST,
        fetchImpl: counting,
        ...(options.sleep ? { sleep: options.sleep } : {}),
        ...(options.random ? { random: options.random } : {}),
      },
    );
    const success = (json as { success?: unknown } | null)?.success === true;
    noteOutcome(success, now());
    return success
      ? { status: 'done', tags: set, requests }
      : { status: 'failed', tags: set, requests, reason: 'refused' };
  } catch (err) {
    noteOutcome(false, now());
    let reason: PurgeReason = 'network';
    if (err instanceof OutboundError) {
      if (err.reason === 'timeout') reason = 'timeout';
      else if (err.reason === 'http' && err.status === 429) reason = 'rate-limited';
      else if (err.reason !== 'network') reason = 'http';
    }
    return { status: 'failed', tags: set, requests, reason };
  }
}
