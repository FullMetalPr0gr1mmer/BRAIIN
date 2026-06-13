import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY } from 'astro:env/client';

// Anonymous read client for public (Tier A) SSR pages. Subject to RLS: the anon
// role sees only `status='published'`, tenant-scoped rows (the anon tenant fence
// resolves to the single launch tenant). NEVER used for writes or admin reads —
// those go through the service-role client + assertCap (Phase 3).
let _anon: SupabaseClient | null = null;

export function anonClient(): SupabaseClient {
  if (!_anon) {
    _anon = createClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _anon;
}
