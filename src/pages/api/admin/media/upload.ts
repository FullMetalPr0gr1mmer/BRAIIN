import { MediaUploadMetaSchema } from '@schemas/media';
import { defineAdminRoute } from '@/lib/admin/route';
import { insertRow } from '@/lib/admin/crud';
import { mediaResource } from '@/lib/admin/resources/media';
import {
  acceptImage,
  readMediaMeta,
  refusalResponse,
  STORAGE_FAILED,
} from '@/lib/admin/mediaUpload';
import { isRefusal } from '@/lib/media/upload';
import { mediaObjectKey, removeMediaObjects, uploadMediaObject } from '@/lib/media/storage';
import { serviceClient } from '@/lib/supabase/server';

// POST /api/admin/media/upload — one image into the library (Admin v2 U3, owner decision
// A5). `media.write` at FULL level: Admin, Content Creator, Developer; SEO's "meta only"
// is refused here (§5). The body is the file itself; its details (bilingual alt, tags,
// folder, the file's name) travel in `x-media-meta` (src/lib/admin/mediaUpload.ts has the
// contract and the order of the checks).
//
// Then: the WebP master goes to the public bucket under a random key (the service role
// writes it), and the row is written AS THE CALLER, so RLS (media_write) is the second,
// independent layer; if the row is refused, the object is deleted again, and whatever that
// misses the daily orphan sweep removes. The audit row names the sizes, never the file name.

export const prerender = false;

type Row = Record<string, unknown>;

export const POST = defineAdminRoute({
  cap: 'media.write',
  handler: async ({ auth, sb, request, audit }) => {
    const meta = MediaUploadMetaSchema.parse(readMediaMeta(request));

    const image = await acceptImage(request, auth);
    if (isRefusal(image)) return refusalResponse(image);

    const svc = serviceClient();
    const key = mediaObjectKey(auth.tenantId, image.width, image.height);
    if (!(await uploadMediaObject(svc, key, image.bytes))) return refusalResponse(STORAGE_FAILED);

    let row: Row;
    try {
      row = await insertRow<Row>(
        sb,
        'media_assets',
        auth,
        {
          kind: 'image',
          provider: 'storage',
          storage_path: key,
          width: image.width,
          height: image.height,
          mime_type: 'image/webp',
          size_bytes: image.bytes.length,
          alt: meta.alt,
          tags: meta.tags,
          folder: meta.folder ?? null,
          display_name: meta.displayName ?? null,
        },
        mediaResource.columns,
        { constraints: mediaResource.constraintFields },
      );
    } catch (err) {
      await removeMediaObjects(svc, [key]);
      throw err;
    }

    audit({
      action: 'media_asset.upload',
      entityType: 'media_asset',
      entityId: String(row['id']),
      detail: {
        input: image.input.format,
        inputBytes: image.input.bytes,
        bytes: image.bytes.length,
        width: image.width,
        height: image.height,
      },
    });
    return mediaResource.fromRow ? mediaResource.fromRow(row) : row;
  },
});
