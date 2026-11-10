import type { SupabaseClient } from '@supabase/supabase-js';

// The daily cron's contact linking (Admin v2 C5, crm.md §5.2): leads that arrived before
// contacts existed, without their indexes, or whose link at arrival failed (it fails open,
// 0131) are linked to their contact here, through public.crm_link_backfill. One call: the
// database walks the queue (leads never linked, indexed, not spam, with an e-mail or phone
// index), each lead in its own sub-transaction, and answers counts. Nothing is decrypted:
// the link compares blind indexes and copies the lead's ciphertext as it is. Run after the
// index backfill, so a lead indexed tonight is linked tonight.

/** Leads per run. The work is the database's (one subrequest), so this bounds its time. */
export const LINK_BATCH = 200;

export interface LinkRun {
  scanned: number;
  /** Joined the contact holding its e-mail. */
  email: number;
  /** Linked by phone, flagged for a person to check. */
  phone: number;
  /** A new contact made from the lead. */
  new: number;
  skipped: number;
  failed: number;
}

const KEYS = ['scanned', 'email', 'phone', 'new', 'skipped', 'failed'] as const;

/** The counts the door answers, or an error for any other shape (never a value). */
export function parseLinkRun(data: unknown): LinkRun {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('contact link backfill: an unexpected answer');
  }
  const out = {} as LinkRun;
  for (const key of KEYS) {
    const value = (data as Record<string, unknown>)[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new Error('contact link backfill: an unexpected answer');
    }
    out[key] = value;
  }
  return out;
}

export async function runContactLinkBackfill(
  sb: SupabaseClient,
  batch: number = LINK_BATCH,
): Promise<LinkRun> {
  const { data, error } = await sb.rpc('crm_link_backfill', { p_limit: batch });
  // The code only: a database message can quote a value.
  if (error) throw new Error(`contact link backfill: ${error.code ?? 'no code'}`);
  return parseLinkRun(data);
}
