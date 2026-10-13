import { z } from 'zod';
import { defineAdminRoute } from '@/lib/admin/route';
import { MEDIA_STORAGE_QUOTA_BYTES } from '@/lib/media/storage';

// GET /api/admin/media/stats — "Storage used: X MB of 1 GB" for the library's toolbar
// (Admin v2 U3; the meter is U4's). Every role that reads the library may (media.write full
// or meta). `public.media_storage_stats()` (0045) is SECURITY INVOKER: RLS decides the rows,
// and it counts nothing unless the tenant named here is the token's own.

export const prerender = false;

const StatsRowSchema = z.object({
  assets: z.coerce.number().int().min(0),
  bytes: z.coerce.number().int().min(0),
});

export const GET = defineAdminRoute({
  cap: 'media.write',
  access: ['full', 'meta'],
  handler: async ({ auth, sb }) => {
    const { data, error } = await sb.rpc('media_storage_stats', { p_tenant: auth.tenantId });
    if (error) throw new Error(`media_storage_stats: ${error.code ?? 'error'}`);
    const row = (Array.isArray(data) ? data[0] : data) ?? { assets: 0, bytes: 0 };
    const { assets, bytes } = StatsRowSchema.parse(row);
    return { assets, bytes, quotaBytes: MEDIA_STORAGE_QUOTA_BYTES };
  },
});
