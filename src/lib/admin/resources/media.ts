import { MediaUpdateSchema, MediaWriteSchema } from '@schemas/admin';
import { isStaticMediaKey, staticImage } from '@/lib/media/static';
import { storageThumbUrl } from '@/lib/media/storageUrl';
import { getRow } from '../crud';
import { ValidationError } from '../errors';
import type { ResourceConfig } from '../resource';
import { pick, type Input } from './shared';

// Media library assets.

/**
 * What an uploaded image's file is: written by the upload and replace routes only (Admin
 * v2 U3). The generic PATCH may restate these unchanged (the form sends every field) but
 * never change them: a new file is a replace, which re-encodes and re-checks it.
 */
const STORAGE_FILE_COLUMNS = [
  'provider',
  'storage_path',
  'kind',
  'width',
  'height',
  'mime_type',
  'size_bytes',
  'stream_uid',
] as const;

/** Equal for an editor's purposes: '' and null are both "nothing". */
function same(a: unknown, b: unknown): boolean {
  const norm = (v: unknown) => (v === '' || v === undefined ? null : v);
  const x = norm(a);
  const y = norm(b);
  return typeof x === 'number' || typeof y === 'number' ? Number(x) === Number(y) : x === y;
}

export const mediaResource: ResourceConfig = {
  table: 'media_assets',
  entity: 'media_asset',
  writeCap: 'media.write',
  readCaps: ['media.write'],
  // 'meta' is included so the SEO role (media.write: 'meta only') can read the library
  // to attach alt text. The metadata-only WRITE path is its own endpoint.
  readAccess: ['full', 'meta'],
  listColumns:
    'id,kind,provider,storage_path,display_name,folder,alt,tags,width,height,size_bytes,ref_count,version,created_at',
  columns:
    'id,kind,provider,storage_path,display_name,folder,alt,tags,width,height,mime_type,size_bytes,stream_uid,ref_count,version,created_at,updated_at',
  orderBy: { column: 'created_at', ascending: false },
  searchColumn: 'storage_path',
  filterableColumns: ['kind', 'folder'],
  createSchema: MediaWriteSchema,
  updateSchema: MediaUpdateSchema,
  // 0045. The display-name CHECK refuses what MediaDisplayNameSchema refuses, so it fires
  // only for a writer that skipped the schema; the index refuses a second row naming one
  // uploaded file (a direct API write; the routes always write a fresh key). The file name
  // has no field on the generic form (the upload dialog sends it), so its message names it.
  constraintFields: {
    media_assets_display_name: {
      message:
        "the file's name must be up to 200 characters, without folders or control characters",
    },
    media_assets_storage_object_key: {
      field: 'storagePath',
      message: 'another image already uses this file',
    },
  },
  toRow: (input) =>
    pick(input as Input, {
      kind: 'kind',
      provider: 'provider',
      storagePath: 'storage_path',
      displayName: 'display_name',
      folder: 'folder',
      alt: 'alt',
      tags: 'tags',
      width: 'width',
      height: 'height',
      mimeType: 'mime_type',
      sizeBytes: 'size_bytes',
      streamUid: 'stream_uid',
    }),
  assertWritable: async (merged, { auth, sb, changed }) => {
    // An uploaded image's file is the upload's: the generic write may not create one, nor
    // repoint, resize or re-type one (the schemas refuse `provider: 'storage'` too).
    if (STORAGE_FILE_COLUMNS.some((column) => column in changed)) {
      if (changed['provider'] === 'storage') {
        throw new ValidationError('uploaded images are added by uploading a file', 'provider');
      }
      if (typeof merged['id'] === 'string') {
        const stored = await getRow<Record<string, unknown>>(
          sb,
          'media_assets',
          auth,
          merged['id'],
          STORAGE_FILE_COLUMNS.join(','),
        );
        if (stored['provider'] === 'storage') {
          const moved = STORAGE_FILE_COLUMNS.find(
            (column) => column in changed && !same(changed[column], stored[column]),
          );
          if (moved) {
            throw new ValidationError(
              'this image was uploaded: use Replace to change its file',
              moved === 'storage_path' ? 'storagePath' : moved,
            );
          }
        }
      }
    }
    // A static asset names a key of the build-time registry, and only a key that exists: an
    // unknown key would be a row the public site silently cannot render.
    if (!('provider' in changed) && !('storage_path' in changed)) return;
    if (merged['provider'] === 'static' && !isStaticMediaKey(String(merged['storage_path']))) {
      throw new ValidationError('not a still shipped with the site', 'storagePath');
    }
  },
  // The picker shows thumbnails: a static still's built asset URL (the admin is exempt from
  // the public image budget, and these frames are ≤ 70 KB), or an upload through `/_image`
  // (img-src has no Supabase origin; the `/_image` guard admits the bucket's keys).
  fromRow: (row) => ({
    ...row,
    thumb_url:
      row['provider'] === 'static'
        ? (staticImage(String(row['storage_path']))?.src ?? null)
        : row['provider'] === 'storage'
          ? storageThumbUrl(String(row['storage_path']))
          : null,
  }),
};
