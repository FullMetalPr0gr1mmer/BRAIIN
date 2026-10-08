import type { Case } from '../harness';

// Website stats (§5 "Analytics — read dashboards", "Search analytics").

export const cases: readonly Case[] = [
  {
    name: 'analytics dashboards',
    load: () => import('@/pages/api/admin/analytics/index'),
    method: 'GET',
    url: '/api/admin/analytics',
    // The one capability all four roles hold.
    allow: ['admin', 'content_creator', 'seo', 'developer'],
  },
  {
    name: 'search analytics',
    load: () => import('@/pages/api/admin/analytics/search'),
    method: 'GET',
    url: '/api/admin/analytics/search',
    allow: ['admin', 'seo', 'developer'],
  },
];
