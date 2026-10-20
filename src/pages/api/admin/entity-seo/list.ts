import { defineAdminRoute } from '@/lib/admin/route';
import { listEntitySeo, SeoListQuerySchema } from '@/lib/admin/seo/list';

// The SEO screen's Pages list (Admin v2 U10, AV-19): one page of pages, services, projects or
// posts with their SEO rows and the defaults the public head uses where a row is blank
// (src/lib/admin/seo/list.ts). `seo.entityMeta` at full (Admin, SEO): Content Creator reads a
// page's meta inside its editor through GET /api/admin/entity-seo, never this list. A read:
// nothing is audited. The kernel turns a malformed query into a 422 (never a logged error).

export const prerender = false;

export const GET = defineAdminRoute({
  cap: 'seo.entityMeta',
  access: ['full'],
  input: SeoListQuerySchema,
  handler: async ({ sb, auth, input }) => listEntitySeo(sb, auth, input),
});
