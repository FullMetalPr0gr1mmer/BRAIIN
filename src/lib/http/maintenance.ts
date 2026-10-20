// Maintenance mode + IP allowlist as a Worker-level PRE-CACHE check (CLAUDE.md Pillar 1): a
// 503 is returned before the edge-cache lookup, so it coexists with the long-`s-maxage`
// Tier-A cache without a purge. `/admin`, `/api`, `/healthz` and `/_image` are exempt.
// Source of truth is `site_settings.maintenance`, snapshotted into KV.
//
// Admin v2 U9b (maintenance v2): the KV value carries everything the 503 needs (the switch,
// the allowlist, the bilingual copy, the background, the contact buttons, "Back on" and its
// instant, the staff bypass: packages/schemas/maintenance.ts), so the request path reads ONE
// KV value and no database. The site comes back at the "Back on" instant with no write: every
// reader here sees the EFFECTIVE state (`getMaintenanceState`), and the cron's reconcile flips
// the stored switch afterwards (src/lib/cron/maintenanceReconcile.ts).

import {
  maintenanceInForce,
  readMaintenance,
  type MaintenanceSnapshot,
} from '@schemas/maintenance';
import type { Locale } from '@schemas/primitives';
import { IDENTITY_FALLBACK } from '@/lib/identity/fallback';
import { maintenancePage } from '@/lib/maintenance/page';

export { normalizeIp } from '@schemas/maintenance';

/** What every reader of the switch sees: in force now or not, and why. */
export interface MaintenanceState {
  /** In force NOW: the stored switch is on and "Back on" has not come. */
  active: boolean;
  allowlist: readonly string[];
  /**
   * When `active` last flipped, as an ISO timestamp (Admin v2 F8: the bell's "Maintenance
   * mode was turned on/off"): the "Back on" instant when it ended by itself (U9b). Absent on
   * a value written before F8.
   */
  changedAt?: string;
  /** True when the stored switch is still on but "Back on" has passed (the bell says so). */
  endedByDate?: boolean;
  /** The value as stored, read leniently (the 503's copy, buttons and bypass). */
  snapshot: MaintenanceSnapshot;
}

export const MAINTENANCE_KV_KEY = 'site:maintenance';

/** The effective state of a stored value at `now`. */
export function effectiveState(snapshot: MaintenanceSnapshot, now: number): MaintenanceState {
  const active = maintenanceInForce(snapshot, now);
  const endedByDate = snapshot.active && !active;
  const changedAt = endedByDate ? (snapshot.untilAt ?? undefined) : snapshot.changedAt;
  return {
    active,
    allowlist: snapshot.allowlist,
    ...(changedAt ? { changedAt } : {}),
    ...(endedByDate ? { endedByDate: true } : {}),
    snapshot,
  };
}

/**
 * Snapshots the value into KV, which is what the middleware actually reads.
 *
 * `site_settings` stays the source of truth, but the pre-cache check runs before the
 * edge-cache lookup on EVERY public request — a Postgres round-trip there would put the
 * database on the critical path of every cache hit, which is the opposite of what
 * Tier A is for. So the admin writes both: the row for durability and audit, this key
 * for the read path. False when the write did not happen (no binding, a KV error).
 */
export async function putMaintenanceState(
  env: { SESSION?: KVNamespace },
  snapshot: MaintenanceSnapshot,
): Promise<boolean> {
  try {
    if (!env.SESSION) return false;
    await env.SESSION.put(MAINTENANCE_KV_KEY, JSON.stringify(snapshot));
    return true;
  } catch {
    return false;
  }
}

/**
 * The KV value as stored (leniently read), or null when there is none or it cannot be read.
 * For the admin and the reconcile, which must tell "unreadable" from "off".
 */
export async function readMaintenanceSnapshot(env: {
  SESSION?: KVNamespace;
}): Promise<MaintenanceSnapshot | null> {
  try {
    const raw = await env.SESSION?.get(MAINTENANCE_KV_KEY);
    return raw ? readMaintenance(raw) : null;
  } catch {
    return null;
  }
}

/**
 * The effective state at `now`. Fails OPEN for the switch (never lock the whole site out on
 * a KV blip: off), and the snapshot's bypass reads off then too (packages/schemas/maintenance.ts).
 */
export async function getMaintenanceState(
  env: { SESSION?: KVNamespace },
  now: number = Date.now(),
): Promise<MaintenanceState> {
  try {
    const raw = await env.SESSION?.get(MAINTENANCE_KV_KEY);
    return effectiveState(readMaintenance(raw ?? null), now);
  } catch {
    return effectiveState(readMaintenance(null), now);
  }
}

export function clientIp(request: Request): string | null {
  const cf = request.headers.get('cf-connecting-ip');
  if (cf) return cf;
  const xff = request.headers.get('x-forwarded-for');
  return xff ? (xff.split(',')[0]?.trim() ?? null) : null;
}

/** The seconds a client should wait: until "Back on" (60 s to a day), else an hour (D11). */
export function retryAfterSeconds(snapshot: MaintenanceSnapshot, now: number): number {
  if (!snapshot.untilAt) return 3600;
  const ms = Date.parse(snapshot.untilAt) - now;
  if (!Number.isFinite(ms)) return 3600;
  return Math.min(86_400, Math.max(60, Math.ceil(ms / 1000)));
}

/**
 * The 503. Takes the request's CSP nonce because this response carries the same strict CSP
 * as every other one, and that CSP has no 'unsafe-inline': the page's styles are in one
 * nonced <style> block (src/lib/maintenance/page.ts). `no-store`: a cache must never keep a
 * maintenance page past the window. No `noindex`: a 503 already says "temporary".
 */
export function maintenanceResponse(
  nonce: string,
  snapshot: MaintenanceSnapshot,
  locale: Locale,
  now: number,
  logoSrc: string | null,
): Response {
  const html = maintenancePage({
    nonce,
    snapshot,
    locale,
    now,
    logoSrc,
    fallbackBrand: IDENTITY_FALLBACK.brandName,
  });
  return new Response(html, {
    status: 503,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'retry-after': String(retryAfterSeconds(snapshot, now)),
      'cache-control': 'no-store',
    },
  });
}
