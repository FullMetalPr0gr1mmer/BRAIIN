import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_URL } from 'astro:env/client';
import { SUPABASE_SERVICE_ROLE_KEY } from 'astro:env/server';

// SERVICE-ROLE client — bypasses RLS. SERVER-ONLY (imports an astro:env secret, which
// throws if ever accessed client-side). Use ONLY in server endpoints that resolve the
// tenant themselves and pair it with assertCap()/explicit checks. Public reads use the
// anon client (src/lib/supabase/client.ts), never this.
let _svc: SupabaseClient | null = null;

export function serviceClient(): SupabaseClient {
  if (!_svc) {
    _svc = createClient(PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _svc;
}
