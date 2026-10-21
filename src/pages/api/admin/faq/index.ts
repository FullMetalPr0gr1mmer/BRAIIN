// Generated shape, hand-owned config. Every method below routes through
// `defineAdminRoute` (assertCap + Zod + audit + no-store) and `crud.ts` (tenant
// predicate + optimistic lock). See src/lib/admin/resource.ts.
import { collectionRoutes } from '@/lib/admin/resource';
import { faqResource } from '@/lib/admin/resources/faq';

export const prerender = false;
export const { GET, POST } = collectionRoutes(faqResource);
