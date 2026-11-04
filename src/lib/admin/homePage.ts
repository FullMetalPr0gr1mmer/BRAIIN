import type { SupabaseClient } from '@supabase/supabase-js';

// The home page's id, for the Loading screen's on/off switch (Admin v2 E7). Read on the server
// under the person's own RLS (pages.write holders read every page of their tenant) AND with the
// tenant named, as every other admin read of public.pages: RLS is the primary layer, the
// predicate the second (E7 review, E7-S1). Without it, a second tenant's home page made visible
// by any future policy would turn this `maybeSingle()` into an error, or worse, a page of the
// wrong tenant.

/** The home page's id (null when the tenant has none), or the read's error message. */
export type HomePageRead = { ok: true; id: string | null } | { ok: false; message: string };

export async function readHomePageId(sb: SupabaseClient, tenantId: string): Promise<HomePageRead> {
  const { data, error } = await sb
    .from('pages')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('slug', 'home')
    .maybeSingle();
  if (error) return { ok: false, message: error.message };
  const id = (data as { id?: unknown } | null)?.id;
  return { ok: true, id: typeof id === 'string' ? id : null };
}
