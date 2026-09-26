import { z } from 'zod';
import { defineAdminRoute } from '@/lib/admin/route';
import { NotFoundError } from '@/lib/admin/errors';
import { getRow } from '@/lib/admin/crud';

// Where a media asset is used: project posters, case-study media, client logos, quote
// avatars, leadership portraits and page sections (`public.media_usage()`, migration
// 0024). The library shows it before anyone replaces or deletes an asset, and the hard
// delete refuses while the list is non-empty (UI v2 PR4b).
//
// Readable by every role that may read the library (media.write full or meta). The
// function is SECURITY INVOKER, so the list is exactly the references the caller's own RLS
// lets them see — staff see their whole tenant.

export const prerender = false;

const UsageRowSchema = z.object({
  entity_type: z.string(),
  entity_id: z.string().uuid(),
  label: z.string().nullable(),
});

export const GET = defineAdminRoute({
  cap: 'media.write',
  access: ['full', 'meta'],
  handler: async ({ auth, sb, params }) => {
    const id = params['id'];
    if (!id || !z.string().uuid().safeParse(id).success) throw new NotFoundError('media_asset');
    // 404 for an asset that is not in this tenant, rather than an empty "unused" answer.
    await getRow(sb, 'media_assets', auth, id, 'id');

    const { data, error } = await sb.rpc('media_usage', { p_media_id: id });
    if (error) throw new Error(`media_usage: ${error.code ?? 'error'}`);
    const usage = z.array(UsageRowSchema).parse(data ?? []);
    return {
      id,
      inUse: usage.length > 0,
      usage: usage.map((u) => ({
        entityType: u.entity_type,
        entityId: u.entity_id,
        label: u.label,
      })),
    };
  },
});
