import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { ContactChannelInput, ContactPatch } from '@schemas/crm';
import type { AuthContext } from '@/lib/auth/types';
import type { Capability } from '@/lib/authz/matrix';
import { AuthorizationError } from '@/lib/authz/errors';
import { constraintOf, getRow, type ConstraintFields } from '@/lib/admin/crud';
import { NotFoundError, OptimisticLockError, ValidationError } from '@/lib/admin/errors';
import { encryptPII } from '@/lib/crypto/pii';
import { blindIndex } from './blindIndex';
import { normalizeEmail, normalizePhone } from './normalize';

// The contacts API's shared Worker half (Admin v2 C6, crm.md §9). The rules live in the
// database (C5's tables and triggers, 0133's readers and doors); this module names the safe
// fields every answer is cut to, turns typed e-mails and phones into ciphertext and blind
// indexes, and translates a database refusal into the status the kernel maps. It never
// decrypts: the reveal (src/pages/api/admin/crm/contacts/[id]/reveal.ts) is the one path
// that does, audited before it reads.

/** A contact id from the path, or a 404 (never a 400: ids are not an oracle). */
export function requireContactId(params: Record<string, string | undefined>): string {
  const id = params['id'];
  if (!id || !z.string().uuid().safeParse(id).success) throw new NotFoundError('contact');
  return id;
}

/** A contact's own columns a staff token reads (never a channel: those are a separate table). */
export const CONTACT_DETAIL_COLUMNS =
  'id,display_name,title,company_name,stage,source,owner_id,locale,city,country,tags,custom,' +
  'is_starred,last_activity_at,created_at,updated_at,created_by,updated_by,version,merged_into';

/** The safe fields of a People list row; anything else an RPC returned is dropped. */
export const CONTACT_LIST_FIELDS = [
  'id',
  'display_name',
  'company_name',
  'title',
  'stage',
  'source',
  'owner_id',
  'locale',
  'city',
  'country',
  'tags',
  'is_starred',
  'last_activity_at',
  'expires_at',
  'created_at',
  'version',
  'has_email',
  'has_phone',
  'leads',
  'to_check',
  'value',
  'score',
] as const;

/** What a picker gets: enough to recognise someone, never how to reach them. */
export const CONTACT_LOOKUP_FIELDS = ['id', 'display_name', 'company_name', 'stage'] as const;

/** A timeline event's fields (metadata only, as the database writes it). */
export const CONTACT_EVENT_FIELDS = [
  'src',
  'id',
  'at',
  'actor_id',
  'kind',
  'detail',
  'lead_id',
  'lead_number',
] as const;

/** A contact's lead, as its page lists it: the safe columns lead workers read anyway. */
export const CONTACT_LEAD_FIELDS = [
  'id',
  'lead_number',
  'name',
  'company',
  'stage_id',
  'is_spam',
  'score',
  'value_sar',
  'created_at',
  'contact_link',
  'source',
] as const;
export const CONTACT_LEAD_COLUMNS = CONTACT_LEAD_FIELDS.join(',');

/** How many of a contact's leads its page lists, newest first. */
export const CONTACT_LEAD_LIMIT = 50;

/**
 * A contact's leads, read as the caller (RLS, the live check, the leads' column grant): the
 * safe columns only, with how each was linked, so a phone match shows as one to check. Newest
 * first, ties broken by id so the order is total; one row past the page is read, so `more`
 * says when the page is not all of them (C6 review, C6-COR-7).
 */
export async function contactLeads(
  sb: SupabaseClient,
  auth: AuthContext,
  contactId: string,
): Promise<{ leads: Record<(typeof CONTACT_LEAD_FIELDS)[number], unknown>[]; more: boolean }> {
  const { data, error } = await sb
    .from('leads')
    .select(CONTACT_LEAD_COLUMNS)
    .eq('tenant_id', auth.tenantId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(CONTACT_LEAD_LIMIT + 1);
  if (error) throw new Error(`contact leads: ${error.code ?? 'no code'}`);
  const rows = (data ?? []) as unknown as Record<string, unknown>[];
  return {
    leads: rows.slice(0, CONTACT_LEAD_LIMIT).map((lead) => {
      const out = {} as Record<(typeof CONTACT_LEAD_FIELDS)[number], unknown>;
      for (const field of CONTACT_LEAD_FIELDS) out[field] = lead[field] ?? null;
      return out;
    }),
    more: rows.length > CONTACT_LEAD_LIMIT,
  };
}

/** One contact, as the caller's own client sees it; a tombstone (C12) is not one. */
export async function getContact(
  sb: SupabaseClient,
  auth: AuthContext,
  id: string,
  columns: string = CONTACT_DETAIL_COLUMNS,
): Promise<Record<string, unknown>> {
  const withMerged = columns.split(',').includes('merged_into')
    ? columns
    : `${columns},merged_into`;
  const row = await getRow<Record<string, unknown>>(sb, 'crm_contacts', auth, id, withMerged);
  if (row['merged_into'] !== null && row['merged_into'] !== undefined) {
    throw new NotFoundError('contact');
  }
  return row;
}

/**
 * What a refused value means, by the constraint the database names. The owner rule is a
 * trigger, so its message names `crm_contacts_owner_active` for this map. Copy follows the
 * admin's rules (P-12): plain, no dashes.
 */
export const CONTACT_CONSTRAINTS: ConstraintFields = {
  crm_contacts_owner_active: {
    field: 'ownerId',
    message: 'That person cannot own contacts. Pick someone who works with contacts.',
  },
  crm_contacts_owner_fk: {
    field: 'ownerId',
    message: 'That person cannot own contacts. Pick someone who works with contacts.',
  },
  crm_contacts_tags_check: {
    field: 'tags',
    message: 'A contact has up to 10 tags, each 1 to 32 characters and used once.',
  },
  crm_contacts_custom_check: {
    field: 'custom',
    message: 'The custom fields hold too much. Shorten some of them.',
  },
  crm_contacts_country_check: { field: 'country', message: 'Use a two-letter country code.' },
  // A rule of public.crm_edit_contact_channels (C6 review, C6-SEC-3), named in its message.
  crm_contact_channels_cap: {
    field: 'channels',
    message: 'A contact keeps up to 10 e-mail addresses and 10 phone numbers. Remove one first.',
  },
};

interface DbError {
  code?: string;
  message?: string;
  details?: string | null;
}

/**
 * A database refusal of a contact read or write, as the error the kernel maps: a bad value
 * a 422 naming its field, a moved version a 409, an unseen row a 404, a refusal by grant,
 * policy or the live check a 403, anything else a 500 whose detail stays in system_logs.
 * Never the database's own text, which can quote values.
 */
export function contactError(
  error: DbError,
  what: string,
  cap: Capability = 'crm.contacts',
): Error {
  switch (error.code) {
    case 'P0002':
      return new NotFoundError('contact');
    case '40001':
      return new OptimisticLockError('crm_contacts');
    case '22023':
      return new ValidationError(`${what} was refused: check the values sent`);
    case '23503':
    case '23505':
    case '23514': {
      const known = CONTACT_CONSTRAINTS[constraintOf(error) ?? ''];
      return new ValidationError(known?.message ?? `${what} was refused`, known?.field);
    }
    case '42501':
      return new AuthorizationError(cap, `${what}: refused by the database`);
    default:
      return new Error(`${what}: ${error.code ?? 'no code'}`);
  }
}

/** The crm_contacts columns a PATCH writes, from what was sent (never the channels). */
export function contactPatchValues(patch: ContactPatch): Record<string, unknown> {
  const map: [keyof ContactPatch, string][] = [
    ['displayName', 'display_name'],
    ['title', 'title'],
    ['companyName', 'company_name'],
    ['stage', 'stage'],
    ['source', 'source'],
    ['ownerId', 'owner_id'],
    ['locale', 'locale'],
    ['city', 'city'],
    ['country', 'country'],
    ['tags', 'tags'],
    ['custom', 'custom'],
    ['isStarred', 'is_starred'],
  ];
  const values: Record<string, unknown> = {};
  for (const [field, column] of map) {
    if (patch[field] !== undefined) values[column] = patch[field];
  }
  return values;
}

/** A channel as a door takes it: ciphertext and blind index, never the value. */
export interface SealedChannel {
  kind: 'email' | 'phone';
  value_enc: string;
  value_hmac: string;
  is_primary: boolean;
}

/** What the screen is told when a typed e-mail or phone cannot be read. */
export const UNREADABLE_CHANNEL: Record<'email' | 'phone', string> = {
  email: 'That e-mail address cannot be read. Check it and try again.',
  phone: 'That phone number cannot be read. Add it with its country code.',
};

/**
 * Encrypts and indexes the e-mails and phones a person typed. A contact's channel always
 * has its blind index (it is how a person is found and kept apart), so one that will not
 * normalise is refused, not stored unindexed as a lead's would be.
 */
export async function sealChannels(
  rootKey: string,
  tenantId: string,
  channels: readonly ContactChannelInput[],
  country: () => Promise<string>,
): Promise<SealedChannel[]> {
  const sealed: SealedChannel[] = [];
  const seen = new Set<string>();
  for (const channel of channels) {
    const normalized =
      channel.kind === 'email'
        ? normalizeEmail(channel.value)
        : normalizePhone(channel.value, await country());
    if (!normalized) throw new ValidationError(UNREADABLE_CHANNEL[channel.kind], 'channels');
    const value_hmac = await blindIndex(rootKey, channel.kind, tenantId, normalized);
    const key = `${channel.kind}:${value_hmac}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sealed.push({
      kind: channel.kind,
      value_enc: await encryptPII(channel.value, rootKey),
      value_hmac,
      is_primary: channel.isPrimary === true,
    });
  }
  return sealed;
}

/** Channel presence for a contact's page: kind, primary, where from. Never a value. */
export async function channelPresence(
  sb: SupabaseClient,
  auth: AuthContext,
  contactId: string,
): Promise<{ id: string; kind: string; is_primary: boolean; source: string }[]> {
  const { data, error } = await sb
    .from('crm_contact_channels')
    .select('id,kind,is_primary,source')
    .eq('tenant_id', auth.tenantId)
    .eq('contact_id', contactId)
    .order('kind', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) throw new Error(`contact channels: ${error.code ?? 'no code'}`);
  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    id: String(row['id']),
    kind: String(row['kind']),
    is_primary: row['is_primary'] === true,
    source: String(row['source']),
  }));
}

/** A page of a contact's timeline as the screen gets it: picked events and the next cursor. */
export interface TimelinePage {
  events: Record<(typeof CONTACT_EVENT_FIELDS)[number], unknown>[];
  next: { before: string; beforeSrc: string; beforeId: number } | null;
}

/** public.crm_contact_timeline's answer, cut to the event fields and a well-formed cursor. */
export function parseTimeline(data: unknown): TimelinePage {
  const body = (data ?? {}) as { events?: unknown; next?: unknown };
  const events = Array.isArray(body.events)
    ? (body.events as Record<string, unknown>[]).map((event) => {
        const out = {} as Record<(typeof CONTACT_EVENT_FIELDS)[number], unknown>;
        for (const field of CONTACT_EVENT_FIELDS) out[field] = event[field] ?? null;
        return out;
      })
    : [];
  const next = body.next as Record<string, unknown> | null | undefined;
  const cursor =
    next &&
    typeof next['before'] === 'string' &&
    typeof next['before_src'] === 'string' &&
    typeof next['before_id'] === 'number'
      ? { before: next['before'], beforeSrc: next['before_src'], beforeId: next['before_id'] }
      : null;
  return { events, next: cursor };
}
