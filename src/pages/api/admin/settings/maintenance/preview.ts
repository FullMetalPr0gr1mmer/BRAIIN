import { z } from 'zod';
import { defineAdminRoute } from '@/lib/admin/route';
import { storedForEditing } from '@/lib/admin/maintenance';
import { IDENTITY_FALLBACK } from '@/lib/identity/fallback';
import { maintenancePage } from '@/lib/maintenance/page';
import { maintenanceLogoSrc } from '@/lib/maintenance/logo';
import { readContact } from '@/lib/maintenance/contact';

// "Preview full screen" (Admin v2 U9b): the maintenance page exactly as visitors get it, from
// the SAVED settings (the row, the source of truth) and the identity as it is now (what the
// buttons show once saved or refreshed), in English or Arabic, by the same page
// function the pre-cache check answers with. Status 200, not 503: it is a preview. Private,
// never stored, never indexed; the strict CSP with this request's nonce, which the page's one
// <style> carries (the middleware adds the header).

export const prerender = false;

const PreviewQuerySchema = z.object({ lang: z.enum(['en', 'ar']).default('en') }).strict();

export const GET = defineAdminRoute({
  cap: 'maintenance.manage',
  input: PreviewQuerySchema,
  handler: async ({ auth, sb, input, cspNonce }) => {
    const { data, error } = await sb
      .from('site_settings')
      .select('maintenance')
      .eq('tenant_id', auth.tenantId)
      .maybeSingle<{ maintenance: unknown }>();
    if (error) throw new Error(`read maintenance: ${error.message}`);
    const now = Date.now();
    const saved = storedForEditing(data?.maintenance ?? null, now);
    const contact = (await readContact(sb, auth.tenantId)) ?? saved.contact;
    const html = maintenancePage({
      nonce: cspNonce,
      snapshot: { ...saved, contact },
      locale: input.lang,
      now,
      logoSrc: await maintenanceLogoSrc(),
      fallbackBrand: IDENTITY_FALLBACK.brandName,
    });
    return new Response(html, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'private, no-store',
        'x-robots-tag': 'noindex',
      },
    });
  },
});
