// Generated shape, hand-owned config. Every method below routes through
// `defineAdminRoute` (assertCap + Zod + audit + no-store) and `crud.ts` (tenant
// predicate + optimistic lock). See src/lib/admin/resource.ts.
import { itemRoutes } from '@/lib/admin/resource';
import { aiQuestionResource } from '@/lib/admin/resources';

export const prerender = false;
export const { GET, PATCH, DELETE } = itemRoutes(aiQuestionResource);
