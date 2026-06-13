import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY } from 'astro:env/client';

// Anonymous read client for public (Tier A) SSR pages. Subject to RLS: the anon
// role sees only `status='published'`, tenant-scoped rows (the anon tenant fence
// resolves to the single launch tenant). NEVER used for writes or admin reads —
// those go through the service-role client + assertCap (Phase 3).
let _anon: SupabaseClient | null = null;

/**
 * False when Supabase isn't wired yet (placeholder/dev URL or key) — callers skip
 * queries to keep dev/build fast and avoid doomed network calls. Real values land at
 * provisioning (KAN-19).
 */
export function supabaseConfigured(): boolean {
  return (
    !!PUBLIC_SUPABASE_URL &&
    !PUBLIC_SUPABASE_URL.includes('example.supabase.co') &&
    !!PUBLIC_SUPABASE_ANON_KEY &&
    PUBLIC_SUPABASE_ANON_KEY !== 'dev-anon-key' &&
    PUBLIC_SUPABASE_ANON_KEY !== 'ci-dummy-anon-key'
  );
}

export function anonClient(): SupabaseClient {
  if (!_anon) {
    _anon = createClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _anon;
}
