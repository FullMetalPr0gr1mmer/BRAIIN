// Generated shape, hand-owned config. Every method below routes through
// `defineAdminRoute` (assertCap + Zod + audit + no-store) and `crud.ts` (tenant
// predicate + optimistic lock). See src/lib/admin/resource.ts.
import { reorderRoute } from '@/lib/admin/resource';
import { sectorResource } from '@/lib/admin/resources/sectors';

export const prerender = false;
export const POST = reorderRoute(sectorResource);
