// Generated shape, hand-owned config. Every method below routes through
// `defineAdminRoute` (assertCap + Zod + audit + no-store) and `crud.ts` (tenant
// predicate + optimistic lock). See src/lib/admin/resource.ts.
import { collectionRoutes } from '@/lib/admin/resource';
import { sectionResource } from '@/lib/admin/resources';

export const prerender = false;
export const { GET, POST } = collectionRoutes(sectionResource);
