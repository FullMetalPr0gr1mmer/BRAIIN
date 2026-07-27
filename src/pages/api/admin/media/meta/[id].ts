import { z } from 'zod';
import { MediaMetaOnlySchema } from '@schemas/admin';
import { defineAdminRoute } from '@/lib/admin/route';
import { NotFoundError } from '@/lib/admin/errors';
import { updateRow } from '@/lib/admin/crud';

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

export const prerender = false;

const COLUMNS = 'id,kind,storage_path,folder,alt,tags,version,updated_at';

export const PATCH = defineAdminRoute({
  cap: 'media.write',
  access: ['full', 'meta'],
  input: MediaMetaOnlySchema,
  handler: async ({ auth, sb, input, params, audit }) => {
    const id = params['id'];
    if (!id || !z.string().uuid().safeParse(id).success) throw new NotFoundError('media_asset');

    const values: Record<string, unknown> = {};
    if (input.alt !== undefined) values['alt'] = input.alt;
    if (input.tags !== undefined) values['tags'] = input.tags;
    if (input.folder !== undefined) values['folder'] = input.folder;

    const row = await updateRow<Record<string, unknown>>(
      sb,
      'media_assets',
      auth,
      id,
      input.version,
      values,
      COLUMNS,
    );
    audit({
      action: 'media_asset.update_meta',
      entityType: 'media_asset',
      entityId: id,
      detail: { fields: Object.keys(values) },
    });
    return row;
  },
});
