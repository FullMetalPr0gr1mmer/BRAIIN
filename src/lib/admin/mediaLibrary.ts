import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { MediaLibraryQuery } from '@schemas/media';
import type { AuthContext } from '@/lib/auth/types';
import { can } from '@/lib/authz/matrix';
import { MEDIA_STORAGE_QUOTA_BYTES } from '@/lib/media/storage';
import { ValidationError } from './errors';
import { uploadsConfigured } from './mediaUpload';
import { mediaResource } from './resources/media';

// The media library's reads (Admin v2 U4), shared by its API routes and the page's first
// render, so the screen and GET /api/admin/media/library answer alike.
//
//   loadMediaLibrary  one page of pictures through `public.media_library` (0064): SECURITY
//                     INVOKER under the caller's own client, the tenant named from the
//                     session (the function answers empty for any other), the search folded
//                     and escaped there. A 22023 (a bound the schema should already have
//                     held) is a 422; any other error is the kernel's 500. Rows go through
//                     the media resource's fromRow, so a tile gets the same `thumb_url` (and
//                     the drawer its `preview_url`) as every other reader of media.
//   loadMediaStats    "Storage used" and whether Upload can be offered (`uploadsReady`, the
//                     upload route's own "Not set up" test; `canUpload`, that and media.write
//                     at full). For the buttons only: the upload route checks both again.

type Row = Record<string, unknown>;

export interface MediaLibraryPage {
  total: number;
  rows: Row[];
}

export interface MediaStats {
  assets: number;
  bytes: number;
  quotaBytes: number;
  uploadsReady: boolean;
  canUpload: boolean;
}

const PageSchema = z.object({
  total: z.coerce.number().int().min(0),
  rows: z.array(z.record(z.unknown())),
});

const StatsRowSchema = z.object({
  assets: z.coerce.number().int().min(0),
  bytes: z.coerce.number().int().min(0),
});

export async function loadMediaLibrary(
  sb: SupabaseClient,
  auth: AuthContext,
  query: MediaLibraryQuery,
): Promise<MediaLibraryPage> {
  const { data, error } = await sb.rpc('media_library', {
    p_tenant: auth.tenantId,
    p_q: query.q ?? null,
    p_kind: query.tab,
    p_needs_alt: query.alt === 'missing',
    p_limit: query.limit,
    p_offset: query.offset,
  });
  if (error) {
    if (error.code === '22023')
      throw new ValidationError('the search or the page is out of range', 'q');
    throw new Error(`media_library: ${error.code ?? 'error'}`);
  }
  if (data === null || data === undefined) return { total: 0, rows: [] };
  const page = PageSchema.parse(data);
  return {
    total: page.total,
    rows: page.rows.map((row) => (mediaResource.fromRow ? mediaResource.fromRow(row) : row)),
  };
}

export async function loadMediaStats(sb: SupabaseClient, auth: AuthContext): Promise<MediaStats> {
  const { data, error } = await sb.rpc('media_storage_stats', { p_tenant: auth.tenantId });
  if (error) throw new Error(`media_storage_stats: ${error.code ?? 'error'}`);
  const row = (Array.isArray(data) ? data[0] : data) ?? { assets: 0, bytes: 0 };
  const { assets, bytes } = StatsRowSchema.parse(row);
  const uploadsReady = uploadsConfigured();
  return {
    assets,
    bytes,
    quotaBytes: MEDIA_STORAGE_QUOTA_BYTES,
    uploadsReady,
    canUpload: uploadsReady && can(auth.role, 'media.write') === 'full',
  };
}
