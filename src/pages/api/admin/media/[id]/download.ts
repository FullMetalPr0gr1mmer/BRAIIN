import { z } from 'zod';
import { defineAdminRoute } from '@/lib/admin/route';
import { getRow } from '@/lib/admin/crud';
import { NotFoundError } from '@/lib/admin/errors';
import { refusalResponse, STORAGE_FAILED } from '@/lib/admin/mediaUpload';
import { NOT_SET_UP } from '@/lib/media/upload';
import { mediaPublicUrl } from '@/lib/media/storageUrl';
import { contentDisposition } from '@/lib/media/download';
import { supabaseConfigured } from '@/lib/supabase/client';

// GET /api/admin/media/[id]/download — an uploaded image's stored file, to keep (Admin v2
// U3; the library's Download button, U4). Every role that reads the library may: media.write
// full or meta, as the list. The path comes from the tenant's own row (RLS), never from the
// request, and the object is streamed through, not held.
//
// Served so a browser saves it rather than renders it here: `attachment`, `nosniff`,
// `no-store`, and a CSP `sandbox` (kept by the middleware's headers) for a tab that opens it
// anyway. What is stored, and so what downloads, is the re-encoded WebP master: the
// original file and its metadata were never kept.

export const prerender = false;

const NO_STORE = 'private, no-store, max-age=0, must-revalidate';

export const GET = defineAdminRoute({
  cap: 'media.write',
  access: ['full', 'meta'],
  handler: async ({ auth, sb, params }) => {
    const id = params['id'];
    if (!id || !z.string().uuid().safeParse(id).success) throw new NotFoundError('media_asset');
    const row = await getRow<Record<string, unknown>>(
      sb,
      'media_assets',
      auth,
      id,
      'id,provider,storage_path,display_name',
    );
    // Only an uploaded image has a stored file to hand back.
    const url = row['provider'] === 'storage' ? mediaPublicUrl(String(row['storage_path'])) : null;
    if (url === null) throw new NotFoundError('media_file');
    if (!supabaseConfigured()) return refusalResponse(NOT_SET_UP);

    let upstream: Response;
    try {
      upstream = await fetch(url);
    } catch {
      return refusalResponse(STORAGE_FAILED);
    }
    if (!upstream.ok || !upstream.body) return refusalResponse(STORAGE_FAILED);

    const headers: Record<string, string> = {
      'content-type': 'image/webp',
      'content-disposition': contentDisposition(row['display_name'], id),
      'cache-control': NO_STORE,
      'x-content-type-options': 'nosniff',
      'content-security-policy': 'sandbox',
    };
    const length = upstream.headers.get('content-length');
    if (length && /^\d+$/.test(length)) headers['content-length'] = length;
    return new Response(upstream.body, { status: 200, headers });
  },
});
