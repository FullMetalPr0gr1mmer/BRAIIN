// The website stats' goals (Admin v2 G1c): list (analytics.read) and create
// (analytics.goals, Admin and SEO). Every method routes through the resource kernel
// (src/lib/admin/resource.ts): assertCap, Zod, the tenant predicate, the audit row.
import { collectionRoutes } from '@/lib/admin/resource';
import { goalResource } from '@/lib/admin/stats/goals';

export const prerender = false;
export const { GET, POST } = collectionRoutes(goalResource);
