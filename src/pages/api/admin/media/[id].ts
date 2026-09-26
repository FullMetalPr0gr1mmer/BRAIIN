import { z } from 'zod';
import { itemRoutes } from '@/lib/admin/resource';
import { defineAdminRoute } from '@/lib/admin/route';
import { mediaResource } from '@/lib/admin/resources';
import { deleteRow, getRow } from '@/lib/admin/crud';
import { InUseError, NotFoundError } from '@/lib/admin/errors';
import { assertCap } from '@/lib/authz/matrix';

// GET + PATCH come from the kernel (assertCap + Zod + audit + no-store, tenant predicate
// + optimistic lock — src/lib/admin/resource.ts).
//
// DELETE is its own route: a HARD delete of a media asset is `media.hardDelete` (§5 —
// Admin only), not the generic `content.archiveDelete`, and it refuses while anything
// still shows the asset. `media_usage()` (migration 0024) lists every reference — a
// poster, a case-study item, a client logo, a quote's avatar, a portrait, a section
// image — so the editor is told where it is used instead of breaking a live page. The
// foreign keys (on delete restrict) are the backstop for the structured references.

export const prerender = false;

export const { GET, PATCH } = itemRoutes(mediaResource);

const UsageSchema = z.array(
  z.object({ entity_type: z.string(), entity_id: z.string(), label: z.string().nullable() }),
);

export const DELETE = defineAdminRoute({
  cap: 'media.hardDelete',
  handler: async ({ auth, sb, params, audit }) => {
    const id = params['id'];
    if (!id || !z.string().uuid().safeParse(id).success) throw new NotFoundError('media_asset');
    // Both: only a role that may manage the library may destroy part of it.
    assertCap(auth, 'media.write', ['full']);
    await getRow(sb, 'media_assets', auth, id, 'id'); // 404 before anything else

    const { data, error } = await sb.rpc('media_usage', { p_media_id: id });
    if (error) throw new Error(`media_usage: ${error.code ?? 'error'}`);
    const usage = UsageSchema.parse(data ?? []);
    if (usage.length > 0) {
      const where = usage
        .slice(0, 5)
        .map((u) => `${u.entity_type.replace('_', ' ')} ${u.label ?? u.entity_id}`)
        .join(', ');
      throw new InUseError(
        `still used by ${usage.length} item(s): ${where}${usage.length > 5 ? ', …' : ''} — replace it there first`,
      );
    }

    await deleteRow(sb, 'media_assets', auth, id, { constraints: mediaResource.constraintFields });
    audit({ action: 'media_asset.delete', entityType: 'media_asset', entityId: id });
    return { deleted: id };
  },
});
