import type { SupabaseClient } from '@supabase/supabase-js';
import { FORM_SETTINGS_PUBLIC_COLUMNS, formSettingsFromRow, type FormSettings } from './config';

// The published forms config as the two public endpoints read it (Admin v2 E8): with the
// service client, for the tenant the endpoint resolved server-side (the anon fence), never
// the page's copy and never anything the visitor sent. The public renderer reads the same
// row through the content seam instead (src/lib/data/forms.ts), so a preview can overlay it.

/**
 * The tenant's published config: the built-in forms when there is no row, null when the row
 * cannot be read (an error or a throw). Each endpoint decides what null means: /api/contact
 * keeps its schema floor (it fails open, EXC-004), /api/apply answers `unavailable` (it fails
 * closed, as its limiter does).
 */
export async function readPublishedFormSettings(
  svc: SupabaseClient,
  tenantId: string,
): Promise<FormSettings | null> {
  try {
    const { data, error } = await svc
      .from('form_settings')
      .select(FORM_SETTINGS_PUBLIC_COLUMNS)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (error) return null;
    return formSettingsFromRow(data);
  } catch {
    return null;
  }
}
