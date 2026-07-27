import { z } from 'zod';
import { defineAdminRoute } from '@/lib/admin/route';
import { NotFoundError } from '@/lib/admin/errors';
import { updateRow } from '@/lib/admin/crud';

// Page visibility toggle — `maintenance.manage` (Admin + Developer).
//
// §5 lists "Maintenance / hidden pages / page visibility" as one Developer capability,
// but Developer holds `pages.write: none`. Without this route that row of the matrix
// would be unimplementable: Developer could SEE the pages list (pageResource grants
// read via `maintenance.manage`) and change nothing on it.
//
// So the capability gets exactly the write it names and no more. `nav_visible` is the
// only field this schema can express — a Developer cannot retitle a page, change its
// slug, or publish it through here, because those fields have nowhere to go.

export const prerender = false;

const VisibilitySchema = z.object({
  navVisible: z.boolean(),
  version: z.number().int().min(1),
});

export const PATCH = defineAdminRoute({
  cap: 'maintenance.manage',
  input: VisibilitySchema,
  handler: async ({ auth, sb, input, params, audit }) => {
    const id = params['id'];
    if (!id || !z.string().uuid().safeParse(id).success) throw new NotFoundError('page');

    const row = await updateRow<Record<string, unknown>>(
      sb,
      'pages',
      auth,
      id,
      input.version,
      { nav_visible: input.navVisible },
      'id,slug,nav_visible,status,version,updated_at',
    );
    audit({
      action: 'page.visibility',
      entityType: 'page',
      entityId: id,
      detail: { navVisible: input.navVisible },
    });
    return row;
  },
});
