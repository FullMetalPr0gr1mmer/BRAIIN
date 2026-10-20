// One website stats goal (Admin v2 G1c): read (analytics.read), update with the version it
// was read at (409 otherwise) and delete (analytics.goals, Admin and SEO). Through the
// resource kernel (src/lib/admin/resource.ts), as every other admin entity.
import { itemRoutes } from '@/lib/admin/resource';
import { goalResource } from '@/lib/admin/stats/goals';

export const prerender = false;
export const { GET, PATCH, DELETE } = itemRoutes(goalResource);
