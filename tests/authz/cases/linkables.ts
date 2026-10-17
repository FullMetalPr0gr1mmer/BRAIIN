import type { Case } from '../harness';

// Where a link field may point (Admin v2 F5b). Everyone who edits a field holding a link
// may ask: content roles (sections, services, projects, posts, the menus) and Developer
// (the footer identity and the theme). SEO holds none of those capabilities (§5) and is
// refused here as it is on every content body — its own fields (meta, canonical,
// redirects) carry no site link picker.

export const cases: readonly Case[] = [
  {
    name: 'link targets (the link field’s picker)',
    load: () => import('@/pages/api/admin/linkables'),
    method: 'GET',
    url: '/api/admin/linkables',
    allow: ['admin', 'content_creator', 'developer'],
  },
];
