import { MediaUpdateSchema, MediaWriteSchema } from '@schemas/admin';
import { isStaticMediaKey, staticImage } from '@/lib/media/static';
import { ValidationError } from '../errors';
import type { ResourceConfig } from '../resource';
import { pick, type Input } from './shared';

// Media library assets.

export const mediaResource: ResourceConfig = {
  table: 'media_assets',
  entity: 'media_asset',
  writeCap: 'media.write',
  readCaps: ['media.write'],
  // 'meta' is included so the SEO role (media.write: 'meta only') can read the library
  // to attach alt text. The metadata-only WRITE path is its own endpoint.
  readAccess: ['full', 'meta'],
  listColumns:
    'id,kind,provider,storage_path,folder,alt,tags,width,height,ref_count,version,created_at',
  columns:
    'id,kind,provider,storage_path,folder,alt,tags,width,height,mime_type,size_bytes,stream_uid,ref_count,version,created_at,updated_at',
  orderBy: { column: 'created_at', ascending: false },
  searchColumn: 'storage_path',
  filterableColumns: ['kind', 'folder'],
  createSchema: MediaWriteSchema,
  updateSchema: MediaUpdateSchema,
  toRow: (input) =>
    pick(input as Input, {
      kind: 'kind',
      provider: 'provider',
      storagePath: 'storage_path',
      folder: 'folder',
      alt: 'alt',
      tags: 'tags',
      width: 'width',
      height: 'height',
      mimeType: 'mime_type',
      sizeBytes: 'size_bytes',
      streamUid: 'stream_uid',
    }),
  // A static asset names a key of the build-time registry, and only a key that exists: an
  // unknown key would be a row the public site silently cannot render.
  assertWritable: (merged, { changed }) => {
    if (!('provider' in changed) && !('storage_path' in changed)) return;
    if (merged['provider'] === 'static' && !isStaticMediaKey(String(merged['storage_path']))) {
      throw new ValidationError('not a still shipped with the site', 'storagePath');
    }
  },
  // The picker shows thumbnails; a static still's built asset URL is one (the admin is
  // exempt from the public image budget, and these frames are ≤ 70 KB).
  fromRow: (row) => ({
    ...row,
    thumb_url:
      row['provider'] === 'static' ? (staticImage(String(row['storage_path']))?.src ?? null) : null,
  }),
};
