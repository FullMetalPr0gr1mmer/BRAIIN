import type { ContactSource, ContactStage } from '@schemas/crm';
import type { BadgeTone } from '@/lib/admin/tones';
import { actorName, eventSentence, type PeopleById, type StagesByKey } from './leadView';

// The words the contacts screens print (Admin v2 C7, crm.md §11 screens 5 and 6). Pure, for the
// pages' server render and the islands alike. Nothing here holds or prints a contact detail: a
// timeline row is metadata only (kinds, field names, ids), and the screens get no channel value
// outside the audited reveal.

export const CONTACT_STAGE_LABELS: Readonly<Record<ContactStage, string>> = {
  lead: 'Lead',
  client: 'Client',
  past: 'Past client',
  partner: 'Partner',
};

/** crm.md §11 screen 5: Lead klein, Client ok, Past client gray, Partner sky. */
export const CONTACT_STAGE_TONES: Readonly<Record<ContactStage, BadgeTone>> = {
  lead: 'klein',
  client: 'ok',
  past: 'gray',
  partner: 'sky',
};

export const CONTACT_SOURCE_LABELS: Readonly<Record<ContactSource, string>> = {
  web_form: 'Website form',
  manual: 'Added by hand',
  referral: 'Referral',
  instagram: 'Instagram',
  event: 'Event',
  google: 'Google',
  linkedin: 'LinkedIn',
  direct: 'Direct',
  whatsapp: 'WhatsApp',
  import: 'Imported',
};

const isKey = <T extends string>(map: Readonly<Record<T, string>>, value: unknown): value is T =>
  typeof value === 'string' && Object.hasOwn(map, value);

export function stageLabel(stage: unknown): string {
  return isKey(CONTACT_STAGE_LABELS, stage) ? CONTACT_STAGE_LABELS[stage] : 'No stage';
}

export function stageToneOf(stage: unknown): BadgeTone {
  return isKey(CONTACT_STAGE_LABELS, stage) ? CONTACT_STAGE_TONES[stage] : 'gray';
}

export function sourceLabelOf(source: unknown): string {
  return isKey(CONTACT_SOURCE_LABELS, source) ? CONTACT_SOURCE_LABELS[source] : 'Not given';
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** A contact's name as the screens print it (one with none still needs a handle). */
export function contactName(contact: object): string {
  return text((contact as { display_name?: unknown }).display_name) || 'A contact with no name';
}

/** "Designer at Acme", "Designer", "At Acme", or '' (the contact page's sub-line). */
export function roleLine(title: unknown, company: unknown): string {
  const t = text(title);
  const c = text(company);
  if (t && c) return `${t} at ${c}`;
  return t || (c ? `At ${c}` : '');
}

/** Someone the screens name: everyone the CRM directory lists, and who may own a contact. */
export interface ContactPerson {
  id: string;
  name: string;
  /** Holds crm.contacts, so the owner rule accepts them (crm_contacts_owner_active). */
  canOwn: boolean;
}

/** The counts POST /api/admin/crm/contacts/summary answers. */
export interface ContactSummary {
  total: number;
  lead: number;
  client: number;
  past: number;
  partner: number;
  starred: number;
  mine: number;
  expiring: number;
  to_check: number;
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "12 people · 3 clients · 8 leads · 1 past client" (crm.md §11 screen 5). */
export function contactsSubline(summary: ContactSummary): string {
  return [
    count(summary.total, 'person', 'people'),
    count(summary.client, 'client', 'clients'),
    count(summary.lead, 'lead', 'leads'),
    count(summary.past, 'past client', 'past clients'),
  ].join(' · ');
}

/** The first `shown` tags, and how many more there are (the list's "+n"). */
export function tagsShown(tags: unknown, shown = 3): { tags: string[]; more: number } {
  const list = Array.isArray(tags) ? tags.filter((t): t is string => typeof t === 'string') : [];
  return { tags: list.slice(0, shown), more: Math.max(0, list.length - shown) };
}

/**
 * `iso` plus `months` calendar months, as Postgres adds an interval (the day clamped to the
 * month's last: 31 January plus one month is 28 or 29 February), or null for a bad date.
 * crm_contacts_list's `expires_at` is `last_activity_at + make_interval(months => …)`.
 */
export function addMonths(iso: string, months: number): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const day = at.getUTCDate();
  const target = new Date(at.getTime());
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + months);
  const last = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return target.toISOString();
}

// ---- The timeline ------------------------------------------------------------------------------

/** One row of public.crm_contact_timeline (metadata only). */
export interface ContactEvent {
  src: 'contact' | 'lead' | string;
  id: number;
  at: string;
  actor_id: string | null;
  kind: string;
  detail: Record<string, unknown> | null;
  lead_id: string | null;
  lead_number: number | null;
}

/** The detail fields' names as a person reads them (details_changed names columns). */
const FIELD_WORDS: Readonly<Record<string, string>> = {
  display_name: 'name',
  title: 'title',
  company_name: 'company',
  source: 'source',
  locale: 'language',
  city: 'city',
  country: 'country',
  tags: 'tags',
  custom: 'custom fields',
};

const KIND_WORDS: Readonly<Record<string, string>> = {
  email: 'E-mail address',
  phone: 'Phone number',
};

function leadRef(number: unknown): string {
  return typeof number === 'number' ? `Lead #${number}` : 'A lead';
}

/** A contact's own event as a sentence. */
function contactSentence(event: ContactEvent, people: PeopleById): string {
  const detail = event.detail ?? {};
  switch (event.kind) {
    case 'created':
      if (detail['source'] === 'web_form' && !event.actor_id) return 'Added from a website inquiry';
      return event.actor_id ? `Added by ${actorName(event.actor_id, people)}` : 'Added';
    case 'stage_changed':
      return `Stage changed from ${stageLabel(detail['from'])} to ${stageLabel(detail['to'])}`;
    case 'owner_changed':
      return typeof detail['to'] === 'string'
        ? `Owner set to ${actorName(detail['to'], people)}`
        : 'Owner removed';
    case 'details_changed': {
      const fields = Array.isArray(detail['fields'])
        ? (detail['fields'] as unknown[]).flatMap((f) =>
            typeof f === 'string' && FIELD_WORDS[f] ? [FIELD_WORDS[f]] : [],
          )
        : [];
      return fields.length > 0 ? `Changed the ${fields.join(', ')}` : 'Details changed';
    }
    case 'lead_linked':
      return detail['by'] === 'phone'
        ? `${leadRef(detail['lead_number'])} linked by phone number`
        : `${leadRef(detail['lead_number'])} linked`;
    case 'channel_added': {
      const what = KIND_WORDS[String(detail['kind'])] ?? 'Contact detail';
      return detail['source'] === 'lead' ? `${what} copied from a lead` : `${what} added`;
    }
    case 'channel_removed':
      return `${KIND_WORDS[String(detail['kind'])] ?? 'Contact detail'} removed`;
    case 'note_added':
      return 'Note added';
    case 'note_deleted':
      return 'Note deleted';
    case 'task_created':
      return 'Task added';
    case 'task_done':
      return 'Task done';
    case 'merged':
      return 'Merged with another contact';
    default:
      return 'Updated';
  }
}

/**
 * One timeline row as a sentence: a contact's own event, or one of its leads' events, named
 * by the lead's number ("Lead #12: Moved from New to Contacted").
 */
export function contactEventSentence(
  event: ContactEvent,
  leadStages: StagesByKey,
  people: PeopleById,
): string {
  if (event.src === 'lead') {
    return `${leadRef(event.lead_number)}: ${eventSentence(event, leadStages, people)}`;
  }
  return contactSentence(event, people);
}

// ---- What a contact's leads add up to ----------------------------------------------------------

/** A contact's lead as its page lists it (CONTACT_LEAD_FIELDS). */
export interface ContactLead {
  id: string;
  lead_number: number | null;
  name: string | null;
  company: string | null;
  stage_id: string | null;
  is_spam: boolean;
  score: number | null;
  value_sar: number | null;
  created_at: string;
  contact_link: string | null;
  source: string | null;
}

/**
 * The contact's score and value as the list derives them (crm.md §5.1, nothing stored): the
 * highest score of its leads, and the sum of its won leads' values, counting only leads linked
 * other than by phone alone (a phone match is not the person's until someone confirms it).
 */
export function leadTotals(
  leads: readonly ContactLead[],
  wonStageIds: ReadonlySet<string>,
): { score: number | null; value: number } {
  let score: number | null = null;
  let value = 0;
  for (const lead of leads) {
    if (lead.contact_link === 'phone') continue;
    if (typeof lead.score === 'number' && (score === null || lead.score > score)) {
      score = lead.score;
    }
    if (lead.stage_id && wonStageIds.has(lead.stage_id) && typeof lead.value_sar === 'number') {
      value += lead.value_sar;
    }
  }
  return { score, value };
}
