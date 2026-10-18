import { z } from 'zod';
import { parseStorageKey } from '@schemas/media';
import { itemRoutes } from '@/lib/admin/resource';
import { defineAdminRoute } from '@/lib/admin/route';
import { mediaResource } from '@/lib/admin/resources/media';
import { deleteRow, getRow } from '@/lib/admin/crud';
import { InUseError, NotFoundError } from '@/lib/admin/errors';
import { assertCap } from '@/lib/authz/matrix';
import { removeObjectIfUnnamed } from '@/lib/media/storage';
import { serviceClient } from '@/lib/supabase/server';

// GET + PATCH come from the kernel (assertCap + Zod + audit + no-store, tenant predicate
// + optimistic lock — src/lib/admin/resource.ts).
//
// DELETE is its own route: a HARD delete of a media asset is `media.hardDelete` (§5 —
// Admin only), not the generic `content.archiveDelete`, and it refuses while anything
// still shows the asset. `media_usage()` (migration 0024) lists every reference — a
// poster, a case-study item, a client logo, a quote's avatar, a portrait, a section
// image — so the editor is told where it is used instead of breaking a live page. The
// foreign keys (on delete restrict) are the backstop for the structured references. Since
// v4 (migration 0066, Admin v2 R5) a pending change that names the asset counts too, and the
// refusal says so ("a pending change to service logo"): publishing it would otherwise point
// live content at a deleted file.
//
// An uploaded image (`storage`, Admin v2 U3) also has a file in the public bucket: once the
// row is gone, the file is removed too (the service role; nothing references the asset, so
// no page can still show it), unless another row still names that file (0045's unique index
// makes that a legacy or hand-edited row, never a second upload row): then it stays, as the
// sweep would keep it. If the removal fails, the row stays deleted and the daily orphan
// sweep removes the file; the audit row says which happened.

export const prerender = false;

export const { GET, PATCH } = itemRoutes(mediaResource);

// Not strict: v4's `pending` column (0066) parses, and defaults to false before it.
const UsageSchema = z.array(
  z.object({
    entity_type: z.string(),
    entity_id: z.string(),
    label: z.string().nullable(),
    pending: z.boolean().default(false),
  }),
);

/** How the refusal names one reference: "service logo", "a pending change to service logo". */
function usageWords(u: z.infer<typeof UsageSchema>[number]): string {
  const what = `${u.entity_type.replace('_', ' ')} ${u.label ?? u.entity_id}`;
  return u.pending ? `a pending change to ${what}` : what;
}

export const DELETE = defineAdminRoute({
  cap: 'media.hardDelete',
  handler: async ({ auth, sb, params, audit }) => {
    const id = params['id'];
    if (!id || !z.string().uuid().safeParse(id).success) throw new NotFoundError('media_asset');
    // Both: only a role that may manage the library may destroy part of it.
    assertCap(auth, 'media.write', ['full']);
    // 404 before anything else; the file's key, while the row still names it.
    const asset = await getRow<Record<string, unknown>>(
      sb,
      'media_assets',
      auth,
      id,
      'id,provider,storage_path',
    );

    const { data, error } = await sb.rpc('media_usage', { p_media_id: id });
    if (error) throw new Error(`media_usage: ${error.code ?? 'error'}`);
    const usage = UsageSchema.parse(data ?? []);
    if (usage.length > 0) {
      const where = usage.slice(0, 5).map(usageWords).join(', ');
      throw new InUseError(
        `still used by ${usage.length} item(s): ${where}${usage.length > 5 ? ', …' : ''} — replace it there first`,
      );
    }

    // The service role may delete any object, so the key must be this tenant's own (the
    // 0045 CHECK holds that too; this does not lean on it).
    const path = String(asset['storage_path'] ?? '');
    const fileKey =
      asset['provider'] === 'storage' && parseStorageKey(path)?.tenantId === auth.tenantId
        ? path
        : null;

    await deleteRow(sb, 'media_assets', auth, id, { constraints: mediaResource.constraintFields });
    const outcome = fileKey === null ? null : await removeObjectIfUnnamed(serviceClient(), fileKey);
    const file =
      outcome === null
        ? {}
        : {
            fileRemoved: outcome === 'removed',
            ...(outcome === 'still-named' || outcome === 'lookup-failed'
              ? { fileKept: outcome }
              : {}),
          };
    audit({
      action: 'media_asset.delete',
      entityType: 'media_asset',
      entityId: id,
      ...(fileKey === null ? {} : { detail: file }),
    });
    return { deleted: id, ...file };
  },
});
