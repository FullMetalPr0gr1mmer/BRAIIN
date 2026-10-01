import type { APIRoute } from 'astro';
import { serviceClient } from '@/lib/supabase/server';
import { supabaseConfigured } from '@/lib/supabase/client';
import { resolveLaunchTenantId } from '@/lib/data/tenant';

// GET /api/apply/status → `{ open }`, never cached. The Join page is Tier A (edge-cached
// for a long time, purged by tag on publish), so it cannot carry a flag the owner flips in
// the admin; the form asks here on load and shows the closed notice before anyone types.
// The apply endpoint enforces the flag on its own either way — this only spares a visitor
// filling in a form that will be refused.
export const prerender = false;

export const GET: APIRoute = async () => {
  let open = false;
  if (supabaseConfigured()) {
    const tenantId = await resolveLaunchTenantId();
    if (tenantId) {
      const { data } = await serviceClient()
        .from('site_profile')
        .select('accepting_applications')
        .eq('tenant_id', tenantId)
        .maybeSingle();
      open = (data as { accepting_applications?: unknown } | null)?.accepting_applications === true;
    }
  }
  return new Response(JSON.stringify({ open }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
};
