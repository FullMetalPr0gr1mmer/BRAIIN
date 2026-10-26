import { MediaUpdateSchema, MediaWriteSchema } from '@schemas/admin';
import { MEDIA_PURGE_TAGS, mediaChangeIsPublic, purgeAfterSave } from '@/lib/http/purge';
import { isStaticMediaKey, staticImage } from '@/lib/media/static';
import { PREVIEW_WIDTH, storageThumbUrl } from '@/lib/media/storageUrl';
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

/**
 * The admin thumbnail of a picture embedded in another list (Admin v2 U5, U6): a discipline's,
 * a service's or a project's poster, selected as `poster:poster_media_id(provider,storage_path)`
 * so a list shows its pictures with no read per row. The same URL the library's tiles use
 * (`thumb_url` below); null for anything else (no poster, a provider the admin cannot draw,
 * or a row the caller may not read, which PostgREST embeds as null).
 */
export const POSTER_EMBED = 'poster:poster_media_id(provider,storage_path)';

export function posterThumb(embedded: unknown): string | null {
  if (!embedded || typeof embedded !== 'object' || Array.isArray(embedded)) return null;
  const media = embedded as Record<string, unknown>;
  const path = typeof media['storage_path'] === 'string' ? media['storage_path'] : '';
  if (!path) return null;
  if (media['provider'] === 'storage') return storageThumbUrl(path);
  if (media['provider'] === 'static') return staticImage(path)?.src ?? null;
  return null;
}

/** A list row with its embedded poster turned into `poster_thumb_url` (the embed dropped). */
export function withPosterThumb(row: Record<string, unknown>): Record<string, unknown> {
  if (!('poster' in row)) return row;
  const { poster, ...rest } = row;
  return { ...rest, poster_thumb_url: posterThumb(poster) };
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
  // An edit that moves a public column (alt, a still's key, the kind, the dimensions...)
  // changes what the pages showing the row render: `media:all` is purged (Admin v2 R7; a
  // logged-nothing no-op until a cache zone exists, O-3). Tags, folder and the name alone are
  // the library's own and purge nothing. The row before is the PATCH's own read (this
  // resource has rules, so the kernel always reads it); without it the save purges. A new row
  // is shown nowhere yet. It returns nothing, so the answer and the audit row are as before.
  afterWrite: async ({ auth, operation, before, row }) => {
    if (operation === 'update' && mediaChangeIsPublic(before, row)) {
      await purgeAfterSave(auth.tenantId, MEDIA_PURGE_TAGS, 'media');
    }
  },
  // The picker shows thumbnails: a static still's built asset URL (the admin is exempt from
  // the public image budget, and these frames are ≤ 70 KB), or an upload through `/_image`
  // (img-src has no Supabase origin; the `/_image` guard admits the bucket's keys). The
  // library's drawer (Admin v2 U4) shows a larger preview: the same still, or the upload at
  // PREVIEW_WIDTH (640 px, D8).
  fromRow: (row) => {
    const path = String(row['storage_path']);
    const still = row['provider'] === 'static' ? (staticImage(path)?.src ?? null) : null;
    const upload = row['provider'] === 'storage';
    return {
      ...row,
      thumb_url: upload ? storageThumbUrl(path) : still,
      preview_url: upload ? storageThumbUrl(path, undefined, PREVIEW_WIDTH) : still,
    };
  },
};
