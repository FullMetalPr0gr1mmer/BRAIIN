import { z } from 'zod';

// Site health v2's readings (Admin v2 G2, migration 0067): what `public.health_probes` holds,
// one row per tenant and probe. The service role writes them (the Worker's 10-minute health
// schedule and Check now); Admin and Developer read them. Every stored `facts` object is
// parsed with these schemas on every read: unknown keys are dropped, strings are cut to
// their cap and lists to theirs, so a row written by an older or newer Worker (or edited by
// hand) can never put more than these bounds on a screen. The database's CHECK bounds the
// object's size (16 KB).

export const PROBE_KINDS = ['uptime', 'domain', 'certificate'] as const;
export type ProbeKind = (typeof PROBE_KINDS)[number];

/**
 * A probe's state. `ok`, `warn` and `fail` are judgements of a reading; `info` is a fact that
 * is not a judgement (a Cloudflare address has no domain to renew); `unknown` is "could not
 * be read" (no reading yet, or six failed reads in a row); `off` is "not set up" (no monitor
 * key).
 */
export const PROBE_STATES = ['ok', 'warn', 'fail', 'info', 'unknown', 'off'] as const;
export type ProbeState = (typeof PROBE_STATES)[number];

/** A monitor's status as the provider reports it, in our words. */
export const MONITOR_STATUSES = ['up', 'down', 'seems-down', 'paused', 'not-checked'] as const;
export type MonitorStatus = (typeof MONITOR_STATUSES)[number];

/** The caps the screens rely on. */
export const PROBE_CAPS = {
  days: 90,
  incidents: 10,
  responseTimes: 48,
  monitors: 5,
  monitorName: 60,
  monitorPath: 120,
  reason: 120,
  issuer: 60,
  registrar: 80,
  apex: 253,
} as const;

/** A string cut to `max` characters (code units), never refused for its length. */
const capped = (max: number) =>
  z.preprocess((v) => (typeof v === 'string' ? v.slice(0, max) : v), z.string());

/** A list cut to its first `max` items, never refused for its length. */
const list = <T extends z.ZodTypeAny>(item: T, max: number) =>
  z.preprocess((v) => (Array.isArray(v) ? v.slice(0, max) : v), z.array(item));

/** An instant as an ISO string. */
const instant = z.string().datetime({ offset: true });
/** A calendar day, YYYY-MM-DD (a Riyadh day for the uptime strip). */
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** A percentage. */
const ratio = z.number().min(0).max(100);

export const UptimeDaySchema = z.object({ day, ratio: ratio.nullable() });
export type UptimeDay = z.infer<typeof UptimeDaySchema>;

export const IncidentSchema = z.object({
  id: capped(40),
  start: instant,
  /** How long the site was down, in seconds (up to a year). */
  durationSec: z
    .number()
    .int()
    .min(0)
    .max(366 * 86_400),
  /** The provider's reason, as text (never markup), cut to 120 characters. */
  reason: capped(PROBE_CAPS.reason),
  /** When this Worker first saw it: what lights the bell's dot (F8's watermark rule). */
  seenAt: instant,
});
export type Incident = z.infer<typeof IncidentSchema>;

export const ResponsePointSchema = z.object({
  at: instant,
  ms: z.number().min(0).max(600_000),
});
export type ResponsePoint = z.infer<typeof ResponsePointSchema>;

export const MonitorSchema = z.object({
  name: capped(PROBE_CAPS.monitorName),
  /** The path it watches on this site, or null when it watches another address. */
  path: capped(PROBE_CAPS.monitorPath).nullable(),
  intervalSec: z.number().int().min(0).max(86_400),
  status: z.enum(MONITOR_STATUSES),
});
export type Monitor = z.infer<typeof MonitorSchema>;

/** What the uptime monitor reported, with the incidents this Worker has seen. */
export const UptimeFactsSchema = z.object({
  ratio30: ratio.nullable(),
  ratio90: ratio.nullable(),
  /** The last 90 Riyadh days, oldest first. */
  days: list(UptimeDaySchema, PROBE_CAPS.days),
  /** Outages in the last 90 days, newest first. */
  incidents: list(IncidentSchema, PROBE_CAPS.incidents),
  /** The first monitor's hourly averages over 48 hours, oldest first. */
  responseTimes: list(ResponsePointSchema, PROBE_CAPS.responseTimes),
  monitors: list(MonitorSchema, PROBE_CAPS.monitors),
  /** When a monitor first read down, while one is down. */
  downSince: instant.nullable(),
});
export type UptimeFacts = z.infer<typeof UptimeFactsSchema>;

/** The domain's registration record (RDAP), and the bootstrap entry that found it. */
export const DOMAIN_OUTCOMES = ['ok', 'not-found', 'unknown', 'not-applicable', 'invalid'] as const;
export type DomainOutcome = (typeof DOMAIN_OUTCOMES)[number];

export const RdapBaseSchema = z.object({
  tld: capped(63),
  base: z.string().url().max(200),
  fetchedAt: instant,
});
export type RdapBase = z.infer<typeof RdapBaseSchema>;

export const DomainFactsSchema = z.object({
  /** The domain checked: always named, so a misspelt tenant domain is visible. */
  apex: capped(PROBE_CAPS.apex).nullable(),
  outcome: z.enum(DOMAIN_OUTCOMES),
  expires: instant.nullable(),
  registrar: capped(PROBE_CAPS.registrar).nullable(),
  /** The IANA bootstrap's entry for the apex's TLD, cached for 30 days. */
  rdap: RdapBaseSchema.nullable(),
});
export type DomainFacts = z.infer<typeof DomainFactsSchema>;

export const CertificateFactsSchema = z.object({
  /** `monitor`: the monitor reported it; `cloudflare`: it did not (Cloudflare renews). */
  source: z.enum(['monitor', 'cloudflare']),
  expires: instant.nullable(),
  issuer: capped(PROBE_CAPS.issuer).nullable(),
});
export type CertificateFacts = z.infer<typeof CertificateFactsSchema>;

export const PROBE_FACTS = {
  uptime: UptimeFactsSchema,
  domain: DomainFactsSchema,
  certificate: CertificateFactsSchema,
} as const;

export interface ProbeFactsOf {
  uptime: UptimeFacts;
  domain: DomainFacts;
  certificate: CertificateFacts;
}

/** The columns a run reads and a screen reads (never `updated_at` or the tenant). */
export const PROBE_COLUMNS =
  'kind,state,facts,read_ok,failures,checked_at,ok_at,next_at,state_since';

/** A stored row, as the service role and the readers select it. */
export const ProbeRowSchema = z.object({
  kind: z.enum(PROBE_KINDS),
  state: z.enum(PROBE_STATES),
  facts: z.unknown(),
  read_ok: z.boolean(),
  failures: z.number().int().min(0),
  checked_at: z.string().nullable(),
  ok_at: z.string().nullable(),
  next_at: z.string().nullable(),
  state_since: z.string(),
});
export type ProbeRow = z.infer<typeof ProbeRowSchema>;

/**
 * A row's facts for its kind, or null when they are empty (never read) or do not parse (a
 * row the screens then show as "could not be read", never a crash).
 */
export function probeFacts<K extends ProbeKind>(kind: K, raw: unknown): ProbeFactsOf[K] | null {
  const parsed = PROBE_FACTS[kind].safeParse(raw);
  return parsed.success ? (parsed.data as ProbeFactsOf[K]) : null;
}
