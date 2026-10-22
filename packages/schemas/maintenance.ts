import { z } from 'zod';

// Maintenance mode v2 (Admin v2 U9b): one value, `site_settings.maintenance` (the source of
// truth) and its KV snapshot `site:maintenance` (what the pre-cache check reads, CLAUDE.md §3),
// carrying everything the 503 needs, so no database is on the request path: the switch, the
// IP allowlist, the bilingual copy, the background, the contact buttons (a snapshot of
// site_profile taken at save time), the "Back on" day and its instant, and the staff bypass.
//
// Two readers, two rules:
//   - the admin's write, MaintenanceInputSchema: strict Zod, every field optional so a save
//     names what it changes and the route lays it over the stored value;
//   - every other reader (the middleware, the bell, the reconcile, the admin GET), through
//     readMaintenance(): lenient per field, by hand (no Zod on the hot path). Unreadable means
//     OFF for the switch (fail open: a KV blip never locks the site out) and OFF for the
//     staff bypass (fail CLOSED: an unreadable value never lets anyone past). A v1 value
//     (`{active, allowlist, changedAt}`, before U9b) reads as v2 with the bypass off.

export const MAINTENANCE_TITLE_MAX = 80;
export const MAINTENANCE_MESSAGE_MAX = 280;
export const MAINTENANCE_ALLOWLIST_MAX = 50;
/** "Back on" is at most this many days ahead, in the studio's zone (decision D10). */
export const MAINTENANCE_MAX_DAYS_AHEAD = 30;
export const MAINTENANCE_BACKGROUNDS = ['image', 'black'] as const;
export type MaintenanceBackground = (typeof MAINTENANCE_BACKGROUNDS)[number];

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A calendar day 'YYYY-MM-DD' that exists (no 31 February). */
export function isCalendarDay(value: unknown): value is string {
  if (typeof value !== 'string' || !DAY.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/**
 * One IP address in the form the middleware compares: IPv4 as written (Zod checked its
 * shape), IPv6 canonicalised by the URL parser (lower case, zeros compressed), the same at
 * save and at compare. Null for anything that is not an address.
 */
export function normalizeIp(value: string): string | null {
  const ip = value.trim();
  if (ip.length === 0 || ip.length > 45) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    return ip.split('.').every((part) => Number(part) <= 255 && String(Number(part)) === part)
      ? ip
      : null;
  }
  if (!ip.includes(':') || !/^[0-9A-Fa-f:.]+$/.test(ip)) return null;
  try {
    const host = new URL(`http://[${ip}]`).hostname;
    return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : null;
  } catch {
    return null;
  }
}

/** Plain text: no control characters; a line break in the message becomes a space. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const text = (max: number) =>
  z
    .string()
    .transform((v) => v.replace(/\s+/g, ' ').trim())
    .pipe(
      z
        .string()
        .min(1)
        .max(max)
        .refine((v) => !CONTROL.test(v), 'plain text'),
    );
const bilingual = (max: number) => z.object({ en: text(max), ar: text(max) }).strict();

const IpSchema = z
  .string()
  .max(45)
  .transform((v, ctx) => {
    const ip = normalizeIp(v);
    if (ip === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'an IPv4 or IPv6 address' });
      return z.NEVER;
    }
    return ip;
  });

/**
 * The admin's save (PATCH /api/admin/settings/maintenance). Every field but `version` is
 * optional: the route lays what is sent over the stored value, so Turn on can send the
 * switch alone. `until` is a calendar day; the route turns it into the instant (midnight in
 * the studio's zone) and refuses a day that is not tomorrow to 30 days ahead.
 */
export const MaintenanceInputSchema = z
  .object({
    active: z.boolean().optional(),
    /** IPv4/IPv6 literals only: a hostname here would need DNS at request time. */
    allowlist: z
      .array(IpSchema)
      .max(MAINTENANCE_ALLOWLIST_MAX)
      .transform((ips) => [...new Set(ips)])
      .optional(),
    staffBypass: z.boolean().optional(),
    until: z.string().refine(isCalendarDay, 'a day, YYYY-MM-DD').nullable().optional(),
    showDate: z.boolean().optional(),
    background: z.enum(MAINTENANCE_BACKGROUNDS).optional(),
    showContact: z.boolean().optional(),
    title: bilingual(MAINTENANCE_TITLE_MAX).nullable().optional(),
    message: bilingual(MAINTENANCE_MESSAGE_MAX).nullable().optional(),
    version: z.number().int().min(0),
  })
  .strict();
export type MaintenanceInput = z.infer<typeof MaintenanceInputSchema>;

/** The legacy name, kept for its importers (U9b moved the schema here from admin.ts). */
export const MaintenanceSchema = MaintenanceInputSchema;

// ── The stored value ────────────────────────────────────────────────────────────────────

export interface Bilingual {
  en: string;
  ar: string;
}

/** What the 503's contact buttons show: site_profile at save time. */
export interface MaintenanceContact {
  brand: Bilingual | null;
  email: string | null;
  whatsappE164: string | null;
}

export interface MaintenanceSnapshot {
  v: 2;
  /** The stored switch. Whether maintenance is in force now also asks `untilAt`. */
  active: boolean;
  allowlist: string[];
  /** When `active` last flipped (Admin v2 F8, the bell). */
  changedAt?: string;
  staffBypass: boolean;
  /** "Back on", the studio's calendar day, and the instant it starts (00:00 in that zone). */
  until: string | null;
  untilAt: string | null;
  showDate: boolean;
  background: MaintenanceBackground;
  showContact: boolean;
  copy: { title: Bilingual | null; message: Bilingual | null };
  contact: MaintenanceContact;
}

/** The value of a tenant that never saved maintenance: off, the bypass on (decision D14). */
export const MAINTENANCE_DEFAULTS: MaintenanceSnapshot = {
  v: 2,
  active: false,
  allowlist: [],
  staffBypass: true,
  until: null,
  untilAt: null,
  showDate: false,
  background: 'image',
  showContact: true,
  copy: { title: null, message: null },
  contact: { brand: null, email: null, whatsappE164: null },
};

type Loose = Record<string, unknown>;
const isObject = (v: unknown): v is Loose =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isoOrNull = (v: unknown): string | null =>
  typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v)) ? v : null;

function bilingualOrNull(v: unknown, max: number): Bilingual | null {
  if (!isObject(v)) return null;
  const { en, ar } = v;
  const ok = (s: unknown): s is string =>
    typeof s === 'string' && s.length > 0 && s.length <= max && !CONTROL.test(s);
  return ok(en) && ok(ar) ? { en, ar } : null;
}

/**
 * Any stored value, read leniently per field (see the header). Never throws. An absent,
 * unparseable or non-object value is maintenance OFF with the bypass OFF: unreadable, so
 * nothing is assumed, least of all a way past the 503.
 */
export function readMaintenance(raw: unknown): MaintenanceSnapshot {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      value = null;
    }
  }
  if (!isObject(value)) return { ...MAINTENANCE_DEFAULTS, staffBypass: false };
  const v2 = value['v'] === 2;
  const allowlist = Array.isArray(value['allowlist'])
    ? value['allowlist']
        .filter((ip): ip is string => typeof ip === 'string')
        .map(normalizeIp)
        .filter((ip): ip is string => ip !== null)
        .slice(0, MAINTENANCE_ALLOWLIST_MAX)
    : [];
  const until = isCalendarDay(value['until']) ? value['until'] : null;
  const untilAt = until ? isoOrNull(value['untilAt']) : null;
  const copy = isObject(value['copy']) ? value['copy'] : {};
  const contact = isObject(value['contact']) ? value['contact'] : {};
  const changedAt = isoOrNull(value['changedAt']);
  return {
    v: 2,
    active: value['active'] === true,
    allowlist: [...new Set(allowlist)],
    ...(changedAt ? { changedAt } : {}),
    // Fail closed: only a v2 value that says true lets staff past.
    staffBypass: v2 && value['staffBypass'] === true,
    until: untilAt ? until : null,
    untilAt,
    showDate: value['showDate'] === true,
    background: value['background'] === 'black' ? 'black' : 'image',
    showContact: v2 ? value['showContact'] !== false : MAINTENANCE_DEFAULTS.showContact,
    copy: {
      title: bilingualOrNull(copy['title'], MAINTENANCE_TITLE_MAX),
      message: bilingualOrNull(copy['message'], MAINTENANCE_MESSAGE_MAX),
    },
    contact: {
      brand: bilingualOrNull(contact['brand'], 200),
      email:
        typeof contact['email'] === 'string' &&
        contact['email'].length <= 254 &&
        /^[^@\s<>"']+@[^@\s<>"']+\.[^@\s<>"']+$/.test(contact['email'])
          ? contact['email']
          : null,
      whatsappE164:
        typeof contact['whatsappE164'] === 'string' &&
        /^\+[1-9][0-9]{7,14}$/.test(contact['whatsappE164'])
          ? contact['whatsappE164']
          : null,
    },
  };
}

/**
 * Whether maintenance is in force at `now`: the switch is on and "Back on" has not come. The
 * site comes back at that instant with no write (the reconcile flips the row afterwards).
 */
export function maintenanceInForce(snapshot: MaintenanceSnapshot, now: number): boolean {
  if (!snapshot.active) return false;
  if (snapshot.untilAt === null) return true;
  return now < Date.parse(snapshot.untilAt);
}

/** The flat shape the admin form edits (GET /api/admin/settings/maintenance). */
export interface MaintenanceForm {
  active: boolean;
  allowlist: string[];
  staffBypass: boolean;
  until: string | null;
  showDate: boolean;
  background: MaintenanceBackground;
  showContact: boolean;
  title: Bilingual | null;
  message: Bilingual | null;
}

export function toMaintenanceForm(s: MaintenanceSnapshot): MaintenanceForm {
  return {
    active: s.active,
    allowlist: s.allowlist,
    staffBypass: s.staffBypass,
    until: s.until,
    showDate: s.showDate,
    background: s.background,
    showContact: s.showContact,
    title: s.copy.title,
    message: s.copy.message,
  };
}
