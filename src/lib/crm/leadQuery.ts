import type { SupabaseClient } from '@supabase/supabase-js';
import { cleanQuery } from '@/lib/admin/globalSearch';
import { normalizeEmail, normalizePhone } from './normalize';
import { blindIndex } from './blindIndex';

// The filter the lead readers send to the database (public.leads_list / leads_board /
// lead_summary, migration 0036). One rule matters more than the rest: a search that is a
// whole e-mail address or phone number becomes a blind-index lookup, so the address itself
// never reaches the database, its logs or a URL (Admin v2 verification D9/D10). Anything
// else is a "contains" search over names, companies and messages.

/** The safe fields of a list row: anything else an RPC returned is dropped, not passed on. */
export const LEAD_LIST_FIELDS = [
  'id',
  'lead_number',
  'name',
  'company',
  'message_preview',
  'service_of_interest',
  'discipline_of_interest',
  'stage_id',
  'is_spam',
  'score',
  'source',
  'channel',
  'created_at',
  'first_response_at',
  'won_at',
  'version',
] as const;

/** The safe fields of a board card. */
export const LEAD_CARD_FIELDS = [
  'id',
  'lead_number',
  'name',
  'company',
  'service_of_interest',
  'discipline_of_interest',
  'score',
  'created_at',
  'version',
] as const;

export function pick<T extends readonly string[]>(
  row: Record<string, unknown>,
  fields: T,
): Record<T[number], unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) out[field] = row[field] ?? null;
  return out as Record<T[number], unknown>;
}

/** Digits (any script), spaces and phone punctuation, at least seven digits. */
const PHONE_LIKE = /^[+\d\s\-().٠-٩۰-۹]+$/;

export interface FilterInput {
  q?: string | undefined;
  [key: string]: unknown;
}

/**
 * The RPC filter for a validated query: snake_case keys, and `q` replaced by a blind index
 * when it is a whole address or number. `country` reads local phone numbers.
 */
export async function toRpcFilter(
  rootKey: string,
  tenantId: string,
  input: FilterInput,
  country: () => Promise<string>,
): Promise<Record<string, unknown>> {
  const { q, perStage, ...rest } = input;
  const filter: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined) filter[key] = value;
  }
  if (perStage !== undefined) filter['per_stage'] = perStage;

  const term = q === undefined ? '' : cleanQuery(q);
  if (!term) return filter;

  if (term.includes('@')) {
    const email = normalizeEmail(term);
    if (email) {
      filter['contact_kind'] = 'email';
      filter['contact_hmac'] = await blindIndex(rootKey, 'email', tenantId, email);
      return filter;
    }
  }
  const digits = term.replace(/[^\d٠-٩۰-۹]/g, '');
  if (PHONE_LIKE.test(term) && digits.length >= 7) {
    const phone = normalizePhone(term, await country());
    if (phone) {
      filter['contact_kind'] = 'phone';
      filter['contact_hmac'] = await blindIndex(rootKey, 'phone', tenantId, phone);
      return filter;
    }
  }
  filter['q'] = term;
  return filter;
}

/** The tenant's country for reading local phone numbers (site_profile, anon-readable). */
export function tenantCountry(sb: SupabaseClient, tenantId: string): () => Promise<string> {
  return async () => {
    const { data } = await sb
      .from('site_profile')
      .select('address_country')
      .eq('tenant_id', tenantId)
      .maybeSingle<{ address_country: string }>();
    return data?.address_country ?? 'SA';
  };
}
