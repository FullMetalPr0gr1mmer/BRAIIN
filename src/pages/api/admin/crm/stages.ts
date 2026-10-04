import { defineAdminRoute } from '@/lib/admin/route';

// The pipeline's stages (Admin v2 C2a), in board order: `leads.manage`. Configuration, not
// personal data; RLS returns the caller's tenant's stages to lead workers only.

export const prerender = false;

const STAGE_COLUMNS = 'id,key,label,label_ar,tone,kind,is_initial,sort_order,version';

export const GET = defineAdminRoute({
  cap: 'leads.manage',
  handler: async ({ auth, sb }) => {
    const { data, error } = await sb
      .from('lead_stages')
      .select(STAGE_COLUMNS)
      .eq('tenant_id', auth.tenantId)
      .order('sort_order', { ascending: true });
    if (error) throw new Error(`lead stages: ${error.message}`);
    return { stages: data ?? [] };
  },
});
