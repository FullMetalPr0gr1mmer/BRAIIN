import { DEFAULT_TIME_ZONE, isStudioTimeZone } from '@schemas/timeZones';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  PROBE_COLUMNS,
  ProbeRowSchema,
  probeFacts,
  type CertificateFacts,
  type DomainFacts,
  type Incident,
  type ProbeKind,
  type ProbeRow,
  type ProbeState,
  type UptimeFacts,
} from '@schemas/healthProbe';
import { writeSystemLog } from '@/lib/data/systemLog';
import { OutboundError } from '@/lib/http/outbound';
import { apexOf } from './domain';
import { THRESHOLDS, daysUntil } from './thresholds';

export { THRESHOLDS, daysUntil } from './thresholds';
import { fetchRdapBase, readDomainExpiry } from './rdap';
import {
  uptimeProvider,
  UptimeProviderError,
  type UptimeProvider,
  type UptimeReading,
} from './uptime';

// The health probes (Admin v2 G2): one run reads the tenant's three rows, runs each probe
// that is due (every one when `force`, as Check now does), computes each next row with the
// PURE `nextProbe`, writes them in ONE upsert, and logs failures only. The service role
// writes (`health_probes` has no staff write path); the trigger stamps `state_since` and
// `updated_at`.
//
//   uptime       the external monitor's reading (src/lib/health/uptime). No key: `off`.
//   certificate  derived from the same reading: the monitor's certificate expiry when it
//                reports one, otherwise `info` ("issued and renewed by Cloudflare", D3).
//   domain       the registration record (RDAP), about once a day.
//
// The breaker is persisted: a failed read keeps the last facts and state, counts the failure
// and is tried again on the next run of the 10-minute schedule, so six failures in a row, an
// hour after the last good reading, make it `unknown` ("the monitor has not answered"), which
// the bell carries. From then on `next_at` backs off exponentially (10 minutes doubling, at
// most 6 hours, ±20% jitter) and the cron skips the probe until then. Backing off from the
// first failure would push the sixth to four to seven hours (THRESHOLDS promises an hour).

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const TIMING = {
  /** A good uptime reading is due again on the next run of the 10-minute schedule. */
  uptimeEveryMs: 5 * MINUTE,
  /** A good domain reading is due again after 20 hours: about once a day. */
  domainEveryMs: 20 * HOUR,
  /** The IANA bootstrap entry is kept this long. */
  bootstrapTtlMs: 30 * DAY,
  /** A failed read before the probe is stale is tried again on the schedule's next run. */
  retryMs: 5 * MINUTE,
  /** The first backoff once stale, doubling with each failure after it, up to the cap. */
  backoffBaseMs: 10 * MINUTE,
  backoffCapMs: 6 * HOUR,
  /** ± this share of the backoff, so failing probes do not retry in step. */
  backoffJitter: 0.2,
} as const;

/** What a probe's attempt produced. */
export type ProbeOutcome =
  | { kind: 'off' }
  | { kind: 'read'; state: ProbeState; facts: Record<string, unknown>; everyMs: number }
  | { kind: 'failed'; reason: string };

/** The columns a run writes (the trigger owns state_since and updated_at). */
export interface ProbeWrite {
  kind: ProbeKind;
  state: ProbeState;
  facts: Record<string, unknown>;
  read_ok: boolean;
  failures: number;
  checked_at: string;
  ok_at: string | null;
  next_at: string | null;
}

/**
 * The wait before the next attempt after `failures` failed reads in a row: the schedule's
 * next run until the probe is stale (THRESHOLDS.staleAfter), then the backoff, starting
 * over at its base with the read that made it stale.
 */
export function retryAfterMs(failures: number, random: () => number = Math.random): number {
  return failures < THRESHOLDS.staleAfter
    ? TIMING.retryMs
    : backoffMs(failures - THRESHOLDS.staleAfter + 1, random);
}

/** The `n`th backoff in a row (1: the base), with its jitter. */
export function backoffMs(failures: number, random: () => number = Math.random): number {
  const base = Math.min(TIMING.backoffBaseMs * 2 ** Math.max(0, failures - 1), TIMING.backoffCapMs);
  return Math.round(base * (1 + TIMING.backoffJitter * (2 * random() - 1)));
}

/**
 * The next row for a probe, from its previous row (or none) and what the attempt produced.
 * Pure: the clock and the jitter are arguments.
 */
export function nextProbe(
  kind: ProbeKind,
  prev: ProbeRow | null,
  outcome: ProbeOutcome,
  now: Date,
  random: () => number = Math.random,
): ProbeWrite {
  const at = now.toISOString();
  if (outcome.kind === 'off') {
    return {
      kind,
      state: 'off',
      facts: {},
      read_ok: false,
      failures: 0,
      checked_at: at,
      ok_at: prev?.ok_at ?? null,
      next_at: null,
    };
  }
  if (outcome.kind === 'read') {
    return {
      kind,
      state: outcome.state,
      facts: outcome.facts,
      read_ok: true,
      failures: 0,
      checked_at: at,
      ok_at: at,
      next_at: new Date(now.getTime() + outcome.everyMs).toISOString(),
    };
  }
  const failures = Math.min((prev?.failures ?? 0) + 1, 10_000);
  // A probe that was off (or never read) has nothing to keep: it could not be read.
  const kept =
    prev && prev.state !== 'off'
      ? { state: prev.state, facts: record(prev.facts) }
      : { state: 'unknown' as const, facts: {} };
  return {
    kind,
    state: failures >= THRESHOLDS.staleAfter ? 'unknown' : kept.state,
    facts: kept.facts,
    read_ok: false,
    failures,
    checked_at: at,
    ok_at: prev?.ok_at ?? null,
    next_at: new Date(now.getTime() + retryAfterMs(failures, random)).toISOString(),
  };
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** The uptime state of a reading: down fails, under 99.9% warns. */
export function uptimeState(reading: Pick<UptimeReading, 'monitors' | 'ratio30'>): ProbeState {
  if (reading.monitors.some((m) => m.status === 'down' || m.status === 'seems-down')) return 'fail';
  if (reading.monitors.length === 0) return 'info';
  if (reading.ratio30 !== null && reading.ratio30 < THRESHOLDS.uptimeWarnRatio) return 'warn';
  return 'ok';
}

/** The uptime facts to store: the reading, each incident keeping when it was first seen. */
export function uptimeFacts(
  reading: UptimeReading,
  prev: UptimeFacts | null,
  now: Date,
): UptimeFacts {
  const seen = new Map((prev?.incidents ?? []).map((i) => [i.id, i.seenAt]));
  const incidents: Incident[] = reading.incidents.map((i) => ({
    ...i,
    seenAt: seen.get(i.id) ?? now.toISOString(),
  }));
  const down = uptimeState(reading) === 'fail';
  return {
    ratio30: reading.ratio30,
    ratio90: reading.ratio90,
    days: reading.days,
    incidents,
    responseTimes: reading.responseTimes,
    monitors: reading.monitors,
    downSince: down ? (reading.downSince ?? prev?.downSince ?? now.toISOString()) : null,
  };
}

/** The certificate's facts and state from a reading (D3: the monitor, else Cloudflare). */
export function certificateOutcome(reading: UptimeReading, now: Date): ProbeOutcome {
  if (!reading.certificate) {
    const facts: CertificateFacts = { source: 'cloudflare', expires: null, issuer: null };
    return { kind: 'read', state: 'info', facts, everyMs: TIMING.uptimeEveryMs };
  }
  const facts: CertificateFacts = {
    source: 'monitor',
    expires: reading.certificate.expires,
    issuer: reading.certificate.issuer,
  };
  const left = daysUntil(reading.certificate.expires, now);
  return {
    kind: 'read',
    state: left <= THRESHOLDS.certificateFailDays ? 'fail' : 'ok',
    facts,
    everyMs: TIMING.uptimeEveryMs,
  };
}

/** The domain's state from its facts. */
export function domainState(facts: DomainFacts, now: Date): ProbeState {
  switch (facts.outcome) {
    case 'ok':
      return facts.expires !== null && daysUntil(facts.expires, now) <= THRESHOLDS.domainFailDays
        ? 'fail'
        : 'ok';
    case 'not-found':
    case 'invalid':
      return 'fail';
    default:
      return 'info';
  }
}

/** The failure's reason code for a log line: never a message, a URL or a body. */
function reasonOf(err: unknown): string {
  if (err instanceof OutboundError)
    return err.status === null ? err.reason : `${err.reason} ${err.status}`;
  if (err instanceof UptimeProviderError) return err.reason;
  return 'error';
}

async function readDomain(
  primaryDomain: string | null,
  prev: DomainFacts | null,
  now: Date,
): Promise<DomainFacts> {
  const apex = apexOf(primaryDomain);
  if (apex.kind === 'not-applicable') {
    return {
      apex: apex.host,
      outcome: 'not-applicable',
      expires: null,
      registrar: null,
      rdap: null,
    };
  }
  if (apex.kind === 'invalid') {
    return { apex: apex.host, outcome: 'invalid', expires: null, registrar: null, rdap: null };
  }
  const tldOf = apex.apex.split('.').slice(1).join('.');
  const cached =
    prev?.rdap &&
    (tldOf === prev.rdap.tld || tldOf.endsWith(`.${prev.rdap.tld}`)) &&
    now.getTime() - Date.parse(prev.rdap.fetchedAt) < TIMING.bootstrapTtlMs
      ? prev.rdap
      : null;
  const rdap = cached ?? (await fetchRdapBase(apex.apex, now));
  if (!rdap) {
    return { apex: apex.apex, outcome: 'unknown', expires: null, registrar: null, rdap: null };
  }
  const found = await readDomainExpiry(apex.apex, rdap.base);
  return {
    apex: apex.apex,
    outcome: found.outcome,
    expires: found.outcome === 'ok' ? found.expires : null,
    registrar: found.outcome === 'not-found' ? null : found.registrar,
    rdap,
  };
}

export interface RunOptions {
  /** Run every probe now, whatever its backoff (Check now). */
  force?: boolean;
  now?: Date;
  /** Who runs it, for the failure line: `cron:health-probes` or `admin:health`. */
  source: string;
  /** Seams for tests: the monitor (default: the deployment's) and the jitter. */
  provider?: UptimeProvider | null;
  random?: () => number;
}

export interface RunResult {
  /** Every probe's row after the run (untouched ones as they were). */
  rows: ProbeRow[];
  /** The probes that ran, and those whose read failed (kind and reason code). */
  ran: ProbeKind[];
  failed: { kind: ProbeKind; reason: string }[];
}

const due = (row: ProbeRow | null, now: Date, force: boolean) =>
  force || !row || row.next_at === null || Date.parse(row.next_at) <= now.getTime();

/**
 * One run for a tenant (the launch tenant: the key and the monitors are deployment-wide,
 * D8). Reads: the tenant's domain with its probe rows (one request), the monitor (up to
 * two), the bootstrap when its entry is stale (up to two) and the registry (up to two).
 * Writes: one upsert, and one log line when a read failed (two requests).
 */
export async function runHealthProbes(
  sb: SupabaseClient,
  tenantId: string,
  options: RunOptions,
): Promise<RunResult> {
  const now = options.now ?? new Date();
  const force = options.force ?? false;
  const random = options.random ?? Math.random;
  const provider = options.provider === undefined ? uptimeProvider() : options.provider;

  const { data, error } = await sb
    .from('tenants')
    // The studio's zone rides the same read (Admin v2 U9): the strip's days are its days.
    .select(`primary_domain, health_probes (${PROBE_COLUMNS}), site_settings (timezone)`)
    .eq('id', tenantId)
    .maybeSingle();
  if (error) throw new Error(`read health_probes: ${error.message}`);
  if (!data) throw new Error('read health_probes: no such tenant');
  const tenant = data as {
    primary_domain?: unknown;
    health_probes?: unknown;
    site_settings?: unknown;
  };
  const settings = Array.isArray(tenant.site_settings)
    ? tenant.site_settings[0]
    : tenant.site_settings;
  const zone = (settings as { timezone?: unknown } | null | undefined)?.timezone;
  const tz = isStudioTimeZone(zone) ? zone : DEFAULT_TIME_ZONE;
  const prev = new Map<ProbeKind, ProbeRow>();
  for (const raw of Array.isArray(tenant.health_probes) ? tenant.health_probes : []) {
    const row = ProbeRowSchema.safeParse(raw);
    if (row.success) prev.set(row.data.kind, row.data);
  }
  const prevOf = (kind: ProbeKind) => prev.get(kind) ?? null;
  const primaryDomain = typeof tenant.primary_domain === 'string' ? tenant.primary_domain : null;

  const writes: ProbeWrite[] = [];
  const failed: { kind: ProbeKind; reason: string }[] = [];

  const uptimeTask = async () => {
    const up = prevOf('uptime');
    const cert = prevOf('certificate');
    if (!provider) {
      // Not set up: written once, when it changes (the key removed, or the first run).
      if (up?.state !== 'off') writes.push(nextProbe('uptime', up, { kind: 'off' }, now));
      if (cert?.state !== 'off') writes.push(nextProbe('certificate', cert, { kind: 'off' }, now));
      return;
    }
    if (!due(up, now, force)) return;
    try {
      const reading = await provider.read(now, tz);
      const facts = uptimeFacts(reading, up ? probeFacts('uptime', up.facts) : null, now);
      writes.push(
        nextProbe(
          'uptime',
          up,
          { kind: 'read', state: uptimeState(reading), facts, everyMs: TIMING.uptimeEveryMs },
          now,
        ),
        nextProbe('certificate', cert, certificateOutcome(reading, now), now),
      );
    } catch (err) {
      const reason = reasonOf(err);
      failed.push({ kind: 'uptime', reason });
      // The certificate is read with the uptime: it fails with it, without its own line.
      writes.push(
        nextProbe('uptime', up, { kind: 'failed', reason }, now, random),
        nextProbe('certificate', cert, { kind: 'failed', reason }, now, random),
      );
    }
  };

  const domainTask = async () => {
    const row = prevOf('domain');
    if (!due(row, now, force)) return;
    try {
      const facts = await readDomain(
        primaryDomain,
        row ? probeFacts('domain', row.facts) : null,
        now,
      );
      writes.push(
        nextProbe(
          'domain',
          row,
          { kind: 'read', state: domainState(facts, now), facts, everyMs: TIMING.domainEveryMs },
          now,
        ),
      );
    } catch (err) {
      const reason = reasonOf(err);
      failed.push({ kind: 'domain', reason });
      writes.push(nextProbe('domain', row, { kind: 'failed', reason }, now, random));
    }
  };

  await Promise.all([uptimeTask(), domainTask()]);

  if (writes.length > 0) {
    const { error: writeError } = await sb.from('health_probes').upsert(
      writes.map((w) => ({ tenant_id: tenantId, ...w })),
      { onConflict: 'tenant_id,kind' },
    );
    if (writeError) throw new Error(`write health_probes: ${writeError.message}`);
  }

  // Failures only, and only when they matter: the first failure in a row, the one that makes
  // the probe stale, and every failure someone asked for (Check now). A provider that is
  // down for a day would otherwise write 144 lines.
  const logged = failed.filter((f) => {
    if (force) return true;
    const failures = writes.find((w) => w.kind === f.kind)?.failures ?? 0;
    return failures === 1 || failures === THRESHOLDS.staleAfter;
  });
  if (logged.length > 0) {
    await writeSystemLog({
      level: 'warn',
      source: options.source,
      message: `health probes: ${logged.map((f) => `${f.kind} could not be read (${f.reason})`).join('; ')}`,
      detail: { failed: logged },
    });
  }

  const after = new Map(prev);
  for (const w of writes) {
    const before = prev.get(w.kind);
    // What the stamps trigger does: a new state starts now, and so does going stale (a probe
    // never read is `unknown` from its first failure); otherwise the state keeps its start.
    const wentStale =
      (before?.failures ?? 0) < THRESHOLDS.staleAfter && w.failures >= THRESHOLDS.staleAfter;
    after.set(w.kind, {
      ...w,
      state_since:
        before && before.state === w.state && !wentStale ? before.state_since : now.toISOString(),
    });
  }
  return {
    rows: [...after.values()],
    ran: [...new Set(writes.filter((w) => w.state !== 'off').map((w) => w.kind))],
    failed,
  };
}
