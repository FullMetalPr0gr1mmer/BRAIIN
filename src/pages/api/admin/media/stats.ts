import { defineAdminRoute } from '@/lib/admin/route';
import { loadMediaStats } from '@/lib/admin/mediaLibrary';

// GET /api/admin/media/stats — "Storage used: X MB of 1 GB" for the library's toolbar
// (Admin v2 U3; the meter is U4's). Every role that reads the library may (media.write full
// or meta). `public.media_storage_stats()` (0045) is SECURITY INVOKER: RLS decides the rows,
// and it counts nothing unless the tenant named here is the token's own.
//
// U4 adds two flags, additive: `uploadsReady`, whether this Worker can take an upload at all
// (uploadsConfigured(): the Images binding and Supabase, the test the upload route makes
// before answering "Not set up"), and `canUpload`, that and media.write at full. Both are for
// the screen's buttons only: the upload route checks both again (src/lib/admin/mediaLibrary.ts).

export const prerender = false;

export const GET = defineAdminRoute({
  cap: 'media.write',
  access: ['full', 'meta'],
  handler: ({ auth, sb }) => loadMediaStats(sb, auth),
});
