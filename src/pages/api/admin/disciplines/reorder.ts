// Generated shape, hand-owned config. Every method below routes through
// `defineAdminRoute` (assertCap + Zod + audit + no-store) and `crud.ts` (tenant
// predicate + optimistic lock). See src/lib/admin/resource.ts.
import { reorderRoute } from '@/lib/admin/resource';
import { disciplineResource } from '@/lib/admin/resources/disciplines';

export const prerender = false;
export const POST = reorderRoute(disciplineResource);
