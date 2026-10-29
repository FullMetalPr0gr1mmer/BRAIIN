import type { SupabaseClient } from '@supabase/supabase-js';
import type { MaintenanceContact } from '@schemas/maintenance';

// The maintenance page's contact buttons (Admin v2 U9b) are a SNAPSHOT of the identity
// (`site_profile`: the brand, the email, the WhatsApp number) taken when maintenance is saved,
// so the page needs no database. It is refreshed after an identity save
// (src/lib/admin/singletons/siteProfile.ts afterWrite) and by the cron's reconcile while
// maintenance is on. Once releases stage the identity, R7's post-publish effects must refresh
// it too (as-built U9).

/** The identity's columns the buttons show: what contactFromRow reads, and nothing else. */
export const CONTACT_KEYS = ['brand_name', 'contact_email', 'whatsapp_e164'] as const;

/** The PostgREST select of CONTACT_KEYS. */
export const CONTACT_COLUMNS = CONTACT_KEYS.join(',');

const bilingual = (v: unknown): { en: string; ar: string } | null => {
  if (!v || typeof v !== 'object') return null;
  const { en, ar } = v as { en?: unknown; ar?: unknown };
  return typeof en === 'string' && typeof ar === 'string' && en && ar ? { en, ar } : null;
};

/** The snapshot of an identity row. */
export function contactFromRow(row: Record<string, unknown> | null): MaintenanceContact {
  return {
    brand: bilingual(row?.['brand_name']),
    email: typeof row?.['contact_email'] === 'string' ? row['contact_email'] : null,
    whatsappE164: typeof row?.['whatsapp_e164'] === 'string' ? row['whatsapp_e164'] : null,
  };
}

/**
 * The tenant's identity as the buttons need it, or null when it cannot be read or there is no
 * identity row (R14-prep review): every caller then keeps the buttons it already has, never
 * empty ones put in their place.
 */
export async function readContact(
  sb: SupabaseClient,
  tenantId: string,
): Promise<MaintenanceContact | null> {
  try {
    const { data, error } = await sb
      .from('site_profile')
      .select(CONTACT_COLUMNS)
      .eq('tenant_id', tenantId)
      .maybeSingle<Record<string, unknown>>();
    if (error || !data) return null;
    return contactFromRow(data);
  } catch {
    return null;
  }
}
