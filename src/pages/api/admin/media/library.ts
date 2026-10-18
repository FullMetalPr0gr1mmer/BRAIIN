import { MediaLibraryQuerySchema } from '@schemas/media';
import { defineAdminRoute } from '@/lib/admin/route';
import { loadMediaLibrary } from '@/lib/admin/mediaLibrary';

// GET /api/admin/media/library (Admin v2 U4): one page of the media library, searched and
// filtered, for the library screen and every picture field's picker. Every role that reads
// the library may (media.write full, or meta: SEO opens it to write alt text). The query is
// Zod-bounded here and again by `public.media_library` (0064), which is SECURITY INVOKER
// under the caller's client and answers empty unless the tenant named (the session's) is the
// token's own; a 22023 from it is a 422. `no-store` and the audit-free read are the kernel's.

export const prerender = false;

export const GET = defineAdminRoute({
  cap: 'media.write',
  access: ['full', 'meta'],
  input: MediaLibraryQuerySchema,
  handler: ({ auth, sb, input }) => loadMediaLibrary(sb, auth, input),
});
