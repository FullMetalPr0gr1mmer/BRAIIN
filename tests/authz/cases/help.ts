import type { Case } from '../harness';

// The help centre (Admin v2 U16): every member has one. Which GUIDES each role is shown is
// decided from ROLE_CAPS on the server and pinned role by role in tests/lib/helpCentre.spec.ts;
// RLS keeps every read to the caller's tenant (supabase/tests/help_centre.test.sql). No route
// writes: no staff role edits the guides (CLAUDE.md §5 assigns help no capability).

export const cases: readonly Case[] = [
  {
    name: 'help guides list',
    load: () => import('@/pages/api/admin/help/index'),
    method: 'GET',
    url: '/api/admin/help?screen=/admin/leads',
    allow: ['admin', 'content_creator', 'seo', 'developer'],
  },
  {
    name: 'help search',
    load: () => import('@/pages/api/admin/help/search'),
    method: 'GET',
    url: '/api/admin/help/search?q=password',
    allow: ['admin', 'content_creator', 'seo', 'developer'],
  },
  {
    name: 'help guide',
    load: () => import('@/pages/api/admin/help/article'),
    method: 'GET',
    url: '/api/admin/help/article?slug=finding-your-way',
    allow: ['admin', 'content_creator', 'seo', 'developer'],
  },
];
