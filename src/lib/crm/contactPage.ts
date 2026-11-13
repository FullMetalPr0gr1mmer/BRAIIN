import type { SupabaseClient } from '@supabase/supabase-js';
import type { CustomFieldDefinition } from '@schemas/crm';
import type { AuthContext } from '@/lib/auth/types';
import { writeAudit } from '@/lib/admin/audit';
import { pick } from './leadQuery';
import {
  CONTACT_LIST_FIELDS,
  channelPresence,
  contactError,
  contactLeads,
  getContact,
  parseTimeline,
  type TimelinePage,
} from './contacts';
import { customFieldDefinitions } from './contactCustom';
import { crmPeople } from './people';
import type { ContactLead, ContactPerson, ContactSummary } from './contactView';
import { ROLE_CAPS } from '@/lib/authz/matrix';
import { isRole } from '@/lib/auth/types';

// The contacts pages' server render (Admin v2 C7): what /admin/contacts and
// /admin/contacts/[id] read before their islands hydrate, so each page is complete without
// JavaScript and the island starts from it, and the readers POST …/query and …/summary share
// with them, so a first view and a later read answer the same shape. The page has already
// refused any role without `crm.contacts` (and read nothing then); everything here runs as the
// caller, for the caller's tenant, so RLS, the live check and the column grants decide again.
//
// Round trips on top of the layout's shell (P-15, the Workers Free plan):
//   list     people, summary, page 1                                            = 3
//   contact  the row, then its channels (presence), its leads, its first timeline page,
//            the lead stages, the people, the retention months, the view's audit row = 8
//            (C8b: for a crm.tasks holder the Tasks card's owners come from the same people
//            read, src/lib/crm/people.ts, so the count stays 8; the card reads its tasks
//            itself, after the page is up)
// Never a channel's value or index, a note, a score reason or a decrypted value: those are
// read by the island, through the audited routes, and only on request.

/**
 * The people the screens name (public.crm_people: the tenant's active CRM members, names and
 * roles only), each marked with whether the owner rule accepts them: an active holder of
 * `crm.contacts` (crm_contacts_owner_active). Empty when the directory cannot be read. The
 * directory is read once per request (crmPeople, C8b): the Tasks card's owners
 * (taskPage's readTaskOwners) come from the same read.
 */
export async function readContactPeople(
  sb: SupabaseClient,
  auth: AuthContext,
): Promise<ContactPerson[]> {
  const data = await crmPeople(sb, auth.tenantId);
  if (!data) return [];
  return data.flatMap((person) => {
    if (typeof person['id'] !== 'string') return [];
    const role = person['role'];
    const name =
      typeof person['display_name'] === 'string' && person['display_name'].trim()
        ? person['display_name'].trim()
        : 'A member with no name';
    return [
      {
        id: person['id'],
        name,
        canOwn: isRole(role) && ROLE_CAPS[role]['crm.contacts'] === 'full',
      },
    ];
  });
}

/** One People list row: the safe fields only (CONTACT_LIST_FIELDS). */
export type ContactRow = Record<(typeof CONTACT_LIST_FIELDS)[number], unknown> & { id: string };

export interface ContactPage {
  rows: ContactRow[];
  total: number;
}

const SUMMARY_KEYS = [
  'total',
  'lead',
  'client',
  'past',
  'partner',
  'starred',
  'mine',
  'expiring',
  'to_check',
] as const;

/** public.crm_contact_summary as the caller: counts only, every key a number. */
export async function readContactSummary(
  sb: SupabaseClient,
  tenantId: string,
): Promise<ContactSummary> {
  const { data, error } = await sb.rpc('crm_contact_summary', { p_tenant: tenantId });
  if (error) throw contactError(error, 'the contact counts');
  const body = (data ?? {}) as Record<string, unknown>;
  const out = {} as Record<(typeof SUMMARY_KEYS)[number], number>;
  for (const key of SUMMARY_KEYS) out[key] = typeof body[key] === 'number' ? body[key] : 0;
  return out;
}

/**
 * One page of public.crm_contacts_list for an RPC filter (a search already turned into its
 * blind index by the caller), cut to the safe fields (contactError maps a refused filter to a
 * 422).
 */
export async function readContactList(
  sb: SupabaseClient,
  tenantId: string,
  filter: Record<string, unknown>,
): Promise<ContactPage> {
  const { data, error } = await sb.rpc('crm_contacts_list', {
    p_tenant: tenantId,
    p_filter: filter,
  });
  if (error) throw contactError(error, 'the contact list');
  const body = (data ?? {}) as { total?: unknown; rows?: unknown };
  const rows = Array.isArray(body.rows) ? (body.rows as Record<string, unknown>[]) : [];
  return {
    rows: rows
      .map((row) => pick(row, CONTACT_LIST_FIELDS))
      .filter((row): row is ContactRow => typeof row.id === 'string'),
    total: typeof body.total === 'number' ? body.total : 0,
  };
}

/** The list's first view: the counts and page 1 for the address's filter; each may fail alone. */
export async function readContactsListInitial(
  sb: SupabaseClient,
  auth: AuthContext,
  filter: Record<string, unknown>,
): Promise<{ summary: ContactSummary | null; page: ContactPage | null }> {
  const [summary, page] = await Promise.all([
    readContactSummary(sb, auth.tenantId).catch(() => null),
    readContactList(sb, auth.tenantId, filter).catch(() => null),
  ]);
  return { summary, page };
}

/** A contact's own columns as its page draws them (merged_into left out). */
export type ContactDetailRow = Record<string, unknown> & { id: string; version: number };

export interface ChannelPresence {
  id: string;
  kind: string;
  is_primary: boolean;
  source: string;
}

export interface ContactDetailInitial {
  contact: ContactDetailRow;
  channels: ChannelPresence[];
  leads: ContactLead[];
  moreLeads: boolean;
  timeline: TimelinePage;
  customFields: readonly CustomFieldDefinition[];
  /** The tenant's retention horizon in months, or null when it cannot be read. */
  retentionMonths: number | null;
}

/**
 * How long a contact is kept after its last activity (site_settings.retention.leads_months,
 * the database's own 24 when unset), or null when it cannot be read. Through
 * public.crm_contact_retention_months (Admin v2 C10b), which answers any live crm.contacts
 * holder for the caller's own tenant: the page read site_settings as the caller before, and
 * only CMS staff read that table (app.is_staff()), so a Sales user lost the "kept until" line.
 */
export async function readRetentionMonths(sb: SupabaseClient): Promise<number | null> {
  const { data, error } = await sb.rpc('crm_contact_retention_months');
  if (error) return null;
  return typeof data === 'number' && Number.isInteger(data) && data > 0 ? data : null;
}

/**
 * One contact for its page, as GET /api/admin/crm/contacts/[id] reads it: the row first
 * (getContact: a contact the caller cannot see, or a merge tombstone, is a NotFoundError, the
 * same answer as one that does not exist, and nothing else is read or written), then its
 * channels' presence, its leads, the first page of its timeline and the retention horizon. The
 * view is audited as the route audits it (`crm.contact.view`, no personal data).
 */
export async function readContactDetail(
  sb: SupabaseClient,
  auth: AuthContext,
  id: string,
): Promise<ContactDetailInitial> {
  const row = await getContact(sb, auth, id);
  const [channels, leadPage, timeline, retentionMonths] = await Promise.all([
    channelPresence(sb, auth, id),
    contactLeads(sb, auth, id),
    sb.rpc('crm_contact_timeline', {
      p_tenant: auth.tenantId,
      p_contact: id,
      p_filter: { limit: 30 },
    }),
    readRetentionMonths(sb),
    writeAudit(sb, auth, {
      action: 'crm.contact.view',
      entityType: 'contact',
      entityId: id,
      detail: { via: 'page' },
    }),
  ]);
  if (timeline.error) throw contactError(timeline.error, 'the contact timeline');
  const { merged_into: _merged, ...contact } = row;
  return {
    contact: contact as ContactDetailRow,
    channels,
    leads: leadPage.leads as unknown as ContactLead[],
    moreLeads: leadPage.more,
    timeline: parseTimeline(timeline.data),
    customFields: customFieldDefinitions(),
    retentionMonths,
  };
}
