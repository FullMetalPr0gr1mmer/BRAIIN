// Generated shape, hand-owned config. Every method below routes through
// `defineAdminRoute` (assertCap + Zod + audit + no-store) and `crud.ts` (tenant
// predicate + optimistic lock). See src/lib/admin/resource.ts.
import { itemRoutes } from '@/lib/admin/resource';
import { faqResource } from '@/lib/admin/resources/faq';

export const prerender = false;
export const { GET, PATCH, DELETE } = itemRoutes(faqResource);
