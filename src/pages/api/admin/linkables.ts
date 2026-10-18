import { defineAdminRoute } from '@/lib/admin/route';
import { loadLinkables } from '@/lib/admin/linkables';

// Where a link field can point (Admin v2 F5b): the code routes plus what the CMS has
// published, read through the caller's own client under RLS.
//
// `anyCap` names everyone who edits a field that holds a link — sections and pages, a
// service, a project, a post, the menus, the footer's identity, the theme. SEO holds none
// of them (§5) and is refused, as it is on every content body. Published targets only: a
// draft is not a link, and a picker that offered one would hand an editor a 404 to ship.

export const prerender = false;

export const GET = defineAdminRoute({
  cap: 'pages.write',
  anyCap: [
    'pages.write',
    'services.write',
    'portfolio.write',
    'blog.write',
    'nav.edit',
    'settings.general',
    'theme.edit',
  ],
  handler: async ({ auth, sb }) => ({ links: await loadLinkables(sb, auth) }),
});
