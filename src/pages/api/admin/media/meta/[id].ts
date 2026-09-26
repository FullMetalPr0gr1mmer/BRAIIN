import { z } from 'zod';
import { MediaMetaOnlySchema } from '@schemas/admin';
import { defineAdminRoute } from '@/lib/admin/route';
import { NotFoundError, OptimisticLockError } from '@/lib/admin/errors';
import { getRow, translateWriteError } from '@/lib/admin/crud';

// The SEO role's media write path. §5 gives SEO `media.write: 'meta only'`, and that
// adverb is the entire endpoint: alt text, tags and folder — never `storage_path`,
// `kind`, `stream_uid` or the dimensions.
//
// It is a SEPARATE ROUTE rather than a branch inside the main media PATCH because the
// distinction has to be structural. A single handler that checked the caller's access
// level and then filtered the payload would put "which fields may this role touch"
// inside a conditional, one refactor away from being wrong; here the fields SEO may
// write are the only fields this file's schema can express, and the general media route
// requires 'full' so SEO never reaches it.
//
// The write goes through `public.update_media_meta()` (migration 0020), not a table
// UPDATE: `media_write` never admitted SEO, so RLS filtered SEO's UPDATE to zero rows and
// the editor was told "someone else saved" (a 409) on every attempt. The function writes
// exactly these three columns, tenant-fenced and version-checked, for any staff role —
// the capability check above (full or meta) is the second, independent layer.

export const prerender = false;

const COLUMNS = 'id,kind,storage_path,folder,alt,tags,version,updated_at';

export const PATCH = defineAdminRoute({
  cap: 'media.write',
  access: ['full', 'meta'],
  input: MediaMetaOnlySchema,
  handler: async ({ auth, sb, input, params, audit }) => {
    const id = params['id'];
    if (!id || !z.string().uuid().safeParse(id).success) throw new NotFoundError('media_asset');

    const patch: Record<string, unknown> = {};
    if (input.alt !== undefined) patch['alt'] = input.alt;
    if (input.tags !== undefined) patch['tags'] = input.tags;
    if (input.folder !== undefined) patch['folder'] = input.folder;

    const { data, error } = await sb.rpc('update_media_meta', {
      p_id: id,
      p_version: input.version,
      p_patch: patch,
    });
    if (error) throw translateWriteError(error, 'media_assets', 'write');

    const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
    if (!row) {
      // No row back: the asset is not in this tenant (404), or the version moved on (409).
      // getRow throws NotFoundError for the first; reaching the next line means the second.
      await getRow(sb, 'media_assets', auth, id, COLUMNS);
      throw new OptimisticLockError('media_assets');
    }
    audit({
      action: 'media_asset.update_meta',
      entityType: 'media_asset',
      entityId: id,
      detail: { fields: Object.keys(patch) },
    });
    return row;
  },
});
