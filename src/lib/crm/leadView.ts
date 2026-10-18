import type { LeadChannel, LeadContactChannel, LeadSource } from '@schemas/crm';
import { BADGE_TONES, type BadgeTone } from '@/lib/admin/tones';
import { ADMIN_TIME_ZONE } from '@/lib/admin/relTime';

// How a lead reads on the leads screens (Admin v2 C4a, crm.md §11): the words and tones for
// its interest, source, stage, score and SLA flag, its timeline's sentences, the date ranges
// the list filters by, and money. Pure, with no I/O: the Worker's server-rendered first views
// and the islands (C4b) use the same functions, so a page and its hydrated island print the
// same text.
//
// The admin's copy rules (P-12): plain words, no em or en dashes, digits exactly as typed:
// money is formatted with Latin digits and nothing here maps one script's digits to
// another's.

// ---- Interest ------------------------------------------------------------------------------

/** The slug columns and the labels the server resolved (src/lib/leads/interestLabel.ts). */
export interface LeadInterest {
  service_of_interest: string | null;
  discipline_of_interest?: string | null | undefined;
  service_label?: { en: string; ar: string } | null | undefined;
  discipline_label?: { en: string; ar: string } | null | undefined;
}

/**
 * What the visitor asked about: a service, or a discipline they want help choosing in.
 * The server's label is preferred; the raw slug is what an older API answer carries.
 * `none` is what a lead that named neither shows (the legacy panel passes its own).
 */
export function interestOf(row: LeadInterest, none = 'Not given'): string {
  if (row.service_of_interest) return row.service_label?.en || row.service_of_interest;
  if (row.discipline_of_interest) {
    return `${row.discipline_label?.en || row.discipline_of_interest} (help me choose)`;
  }
  return none;
}

// ---- Source and channel ----------------------------------------------------------------------

/** How each channel reads (the manual-add drawer's words: 'unknown' is "Other"). */
export const CHANNEL_LABELS: Readonly<Record<LeadChannel, string>> = {
  organic: 'Search',
  social: 'Social',
  paid: 'Ads',
  referral: 'Referral',
  direct: 'Direct',
  email: 'E-mail',
  phone: 'Phone',
  walk_in: 'Walk-in',
  whatsapp: 'WhatsApp',
  event: 'Event',
  unknown: 'Other',
};

const SOURCE_LABELS: Readonly<Record<LeadSource, string>> = {
  web_form: 'Web form',
  manual: 'By hand',
  import: 'Imported',
  style_finder: 'Style finder',
};

const isKey = <K extends string>(map: Readonly<Record<K, unknown>>, key: unknown): key is K =>
  typeof key === 'string' && Object.prototype.hasOwnProperty.call(map, key);

/** "Web form", or "By hand · Phone" for a lead added by hand (the channel says how). */
export function sourceLabel(source: unknown, channel: unknown): string {
  if (!isKey(SOURCE_LABELS, source)) return 'Other';
  if (source !== 'manual') return SOURCE_LABELS[source];
  return `${SOURCE_LABELS.manual} · ${isKey(CHANNEL_LABELS, channel) ? CHANNEL_LABELS[channel] : CHANNEL_LABELS.unknown}`;
}

/** The source badge's tone: the web form klein, a lead added by hand sky, the rest gray. */
export function sourceTone(source: unknown): BadgeTone {
  if (source === 'web_form') return 'klein';
  if (source === 'manual') return 'sky';
  return 'gray';
}

// ---- Stage, score, SLA -----------------------------------------------------------------------

/** A stage's badge tone: its stored tone (a fixed palette, 0034), else gray. */
export function stageTone(stage: { tone?: unknown } | null | undefined): BadgeTone {
  const tone = stage?.tone;
  return typeof tone === 'string' && (BADGE_TONES as readonly string[]).includes(tone)
    ? (tone as BadgeTone)
    : 'gray';
}

/** The score bar's band: 75 and up ok, 55 and up klein, below that warn. */
export function scoreBand(score: number): 'ok' | 'klein' | 'warn' {
  if (score >= 75) return 'ok';
  if (score >= 55) return 'klein';
  return 'warn';
}

/**
 * The score bar's width bucket (`.bar-fill[data-width]` in admin.css takes 0, 5, … 100): the
 * score rounded to the nearest 5 and held to 0..100, so markup never carries a style.
 */
export function scoreBucket(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.min(100, Math.max(0, Math.round(score / 5) * 5));
}

/** What a lead over its response time says, in words (never only a colour). */
export const SLA_LABEL = 'Over response time';

/** The SLA flag as text, or null when the lead is within its time. */
export function slaLabel(overSla: unknown): string | null {
  return overSla === true ? SLA_LABEL : null;
}

// ---- Money ----------------------------------------------------------------------------------

const SAR = /* @__PURE__ */ new Intl.NumberFormat('en-GB', {
  numberingSystem: 'latn',
  maximumFractionDigits: 0,
});

/** "50,000 SAR": grouped, Latin digits, no decimals. */
export function formatSar(value: number): string {
  return `${SAR.format(value)} SAR`;
}

// ---- The timeline ------------------------------------------------------------------------------

/** Every kind lead_events holds (0041's CHECK; tests/lib/leadView.spec.ts compares). */
export const LEAD_EVENT_KINDS = [
  'created',
  'stage_changed',
  'assigned',
  'unassigned',
  'value_set',
  'spam_marked',
  'spam_cleared',
  'contact_logged',
  'note_added',
  'note_deleted',
  'contact_linked',
  'task_created',
  'task_done',
  'merged',
  'legacy_backfill',
] as const;
export type LeadEventKind = (typeof LEAD_EVENT_KINDS)[number];

/** One timeline row as GET /api/admin/leads/[id]/events answers it. */
export interface LeadEvent {
  kind: string;
  actor_id: string | null;
  detail?: Record<string, unknown> | null;
}

/** The people the timeline names (public.crm_people): id → display name. */
export type PeopleById = ReadonlyMap<string, string | null>;
/** The tenant's stages by key (stage_changed names keys): key → label. */
export type StagesByKey = ReadonlyMap<string, { label: string }>;

/** A person no longer on the team (or not a lead worker any more). */
export const FORMER_MEMBER = 'Someone no longer on the team';

/** Who did it: a name, "Automatically" (no person: the form, a cron), or a former member. */
export function actorName(actorId: string | null | undefined, people: PeopleById): string {
  if (!actorId) return 'Automatically';
  return people.get(actorId)?.trim() || FORMER_MEMBER;
}

const CONTACT_LOGGED: Readonly<Record<LeadContactChannel, string>> = {
  call: 'Call logged',
  email: 'E-mail logged',
  whatsapp: 'WhatsApp message logged',
  meeting: 'Meeting logged',
  other: 'Contact logged',
};

function stageName(key: unknown, stages: StagesByKey): string {
  if (typeof key !== 'string') return 'a stage';
  return stages.get(key)?.label ?? 'a stage that was removed';
}

/** One timeline row as a sentence, from its kind and its metadata (never a person's details). */
export function eventSentence(event: LeadEvent, stages: StagesByKey, people: PeopleById): string {
  const detail = event.detail ?? {};
  switch (event.kind as LeadEventKind) {
    case 'created':
      // A lead added by hand names who added it; the form's arrives with no person.
      return event.actor_id
        ? `Added by hand by ${actorName(event.actor_id, people)}`
        : 'Arrived through the website form';
    case 'stage_changed':
      return detail['from']
        ? `Moved from ${stageName(detail['from'], stages)} to ${stageName(detail['to'], stages)}`
        : `Moved to ${stageName(detail['to'], stages)}`;
    case 'assigned':
      return `Assigned to ${actorName(typeof detail['to'] === 'string' ? detail['to'] : null, people)}`;
    case 'unassigned':
      return 'Unassigned';
    case 'value_set': {
      const value = Number(detail['value_sar']);
      return detail['value_sar'] === null ||
        detail['value_sar'] === undefined ||
        !Number.isFinite(value)
        ? 'Value cleared'
        : `Value set to ${formatSar(value)}`;
    }
    case 'spam_marked':
      return 'Marked as spam';
    case 'spam_cleared':
      return 'Marked as not spam';
    case 'contact_logged':
      return isKey(CONTACT_LOGGED, detail['channel'])
        ? CONTACT_LOGGED[detail['channel']]
        : CONTACT_LOGGED.other;
    case 'note_added':
      return 'Note added';
    case 'note_deleted':
      return 'Note deleted';
    case 'contact_linked':
      return 'Linked to a contact';
    case 'task_created':
      return 'Task added';
    case 'task_done':
      return 'Task done';
    case 'merged':
      return 'Merged with another record';
    case 'legacy_backfill':
      return 'Moved into the pipeline';
    default:
      return 'Updated';
  }
}

// ---- Date ranges ----------------------------------------------------------------------------------

/** The list's ranges: the last 7, 30 or 90 days, or all time. */
export const LEAD_RANGES = ['7', '30', '90', 'all'] as const;
export type LeadRange = (typeof LEAD_RANGES)[number];

/** A range as lead_summary's half-open instants, and the period of equal length before it. */
export interface RangeInstants {
  from: string;
  to: string;
  prevFrom: string;
  prevTo: string;
}

const DAY_MS = 86_400_000;
const STUDIO_DATE = /* @__PURE__ */ new Intl.DateTimeFormat('en-CA', {
  timeZone: ADMIN_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The studio's UTC offset in minutes at `at` (Asia/Riyadh: +180, no daylight saving). */
function studioOffsetMinutes(at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ADMIN_TIME_ZONE,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(at);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

/**
 * The last N days in the studio's calendar, today included: from midnight N-1 days ago to
 * midnight tonight (Asia/Riyadh), `to` exclusive as lead_summary and leads_list read it, and
 * the N days before that for the deltas. Null for all time (no range, so no deltas).
 */
export function rangeToInstants(range: LeadRange, now: Date): RangeInstants | null {
  if (range === 'all') return null;
  const days = Number(range);
  const [y, m, d] = STUDIO_DATE.format(now).split('-').map(Number) as [number, number, number];
  // Midnight tonight in the studio's zone: tomorrow's date at 00:00 there.
  const tomorrowUtcMidnight = Date.UTC(y, m - 1, d + 1);
  const to = tomorrowUtcMidnight - studioOffsetMinutes(new Date(tomorrowUtcMidnight)) * 60_000;
  const from = to - days * DAY_MS;
  const prevFrom = from - days * DAY_MS;
  const iso = (ms: number) => new Date(ms).toISOString();
  return { from: iso(from), to: iso(to), prevFrom: iso(prevFrom), prevTo: iso(from) };
}
