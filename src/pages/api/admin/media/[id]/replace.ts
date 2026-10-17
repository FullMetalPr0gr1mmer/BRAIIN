import { z } from 'zod';
import { MediaReplaceMetaSchema, parseStorageKey } from '@schemas/media';
import { defineAdminRoute } from '@/lib/admin/route';
import { getRow, updateRow } from '@/lib/admin/crud';
import { NotFoundError, OptimisticLockError, ValidationError } from '@/lib/admin/errors';
import { mediaResource } from '@/lib/admin/resources/media';
import {
  acceptImage,
  readMediaMeta,
  refusalResponse,
  STORAGE_FAILED,
} from '@/lib/admin/mediaUpload';
import { isRefusal } from '@/lib/media/upload';
import {
  mediaObjectKey,
  removeMediaObjects,
  removeObjectIfUnnamed,
  uploadMediaObject,
  type ObjectRemoval,
} from '@/lib/media/storage';
import { serviceClient } from '@/lib/supabase/server';

// POST /api/admin/media/[id]/replace — a new file for an existing image (Admin v2 U3). The
// row keeps its id, so every place that shows it (a poster, a gallery, a section) shows the
// new file; its alt text and tags stay. Same gate and pipeline as an upload, plus the
// version the editor saw (`x-media-meta`: `{ version }`), checked before the file is read
// and again by the UPDATE (409 if someone saved in between).
//
// The new file gets a NEW key, so no cached derivative of the old one is ever served for
// it. By default the old object is not deleted here: no row names it any more, so the next
// daily orphan sweep removes it (src/lib/media/orphans.ts), and a page rendered just before
// the replace still finds its image until then. `removePrevious: true` in the details deletes
// it at once instead, for an image that must come off the web now (a portrait whose subject
// asked); the audit row records which object went, and the response how it went. The audit
// row always names the previous path (\`previousPath\`), removed or not. A still
// shipped with the site (`static`) or a legacy row can be replaced too; it becomes an
// uploaded image (and has no object to remove).

export const prerender = false;

type Row = Record<string, unknown>;

export const POST = defineAdminRoute({
  cap: 'media.write',
  handler: async ({ auth, sb, request, params, audit }) => {
    const id = params['id'];
    if (!id || !z.string().uuid().safeParse(id).success) throw new NotFoundError('media_asset');
    const meta = MediaReplaceMetaSchema.parse(readMediaMeta(request));

    const current = await getRow<Row>(
      sb,
      'media_assets',
      auth,
      id,
      'id,kind,provider,storage_path,version',
    );
    if (current['kind'] !== 'image') {
      throw new ValidationError('only an image can be replaced with an uploaded image', 'kind');
    }
    if (current['version'] !== meta.version) throw new OptimisticLockError('media_assets');

    const image = await acceptImage(request, auth);
    if (isRefusal(image)) return refusalResponse(image);

    const svc = serviceClient();
    const key = mediaObjectKey(auth.tenantId, image.width, image.height);
    if (!(await uploadMediaObject(svc, key, image.bytes))) return refusalResponse(STORAGE_FAILED);

    let row: Row;
    try {
      row = await updateRow<Row>(
        sb,
        'media_assets',
        auth,
        id,
        meta.version,
        {
          provider: 'storage',
          storage_path: key,
          width: image.width,
          height: image.height,
          mime_type: 'image/webp',
          size_bytes: image.bytes.length,
          provider_ref: null,
          stream_uid: null,
          ...(meta.displayName !== undefined ? { display_name: meta.displayName } : {}),
        },
        mediaResource.columns,
        { constraints: mediaResource.constraintFields },
      );
    } catch (err) {
      await removeMediaObjects(svc, [key]);
      throw err;
    }

    // The previous file, when the editor asked for it to go now: only an uploaded image's
    // object under this tenant's own prefix (the service role may delete any object).
    const previousPath = String(current['storage_path'] ?? '');
    const previousKey =
      current['provider'] === 'storage' && parseStorageKey(previousPath)?.tenantId === auth.tenantId
        ? previousPath
        : null;
    const previous: ObjectRemoval | 'none' | null = !meta.removePrevious
      ? null
      : previousKey === null
        ? 'none'
        : await removeObjectIfUnnamed(svc, previousKey);

    audit({
      action: 'media_asset.replace',
      entityType: 'media_asset',
      entityId: id,
      detail: {
        from: current['provider'] ?? null,
        // Always (U4 review sec-1): media_assets keeps no history, so this is the one record
        // of what the picture showed before. A random key or a still's file name, never a
        // person's data; the file's own name (display_name) is not recorded.
        previousPath: previousPath || null,
        input: image.input.format,
        inputBytes: image.input.bytes,
        bytes: image.bytes.length,
        width: image.width,
        height: image.height,
        version: meta.version,
        ...(previous === null
          ? {}
          : { previousFile: previous, ...(previousKey ? { previousKey } : {}) }),
      },
    });
    const out = mediaResource.fromRow ? mediaResource.fromRow(row) : row;
    return previous === null ? out : { ...out, previous_file: previous };
  },
});
