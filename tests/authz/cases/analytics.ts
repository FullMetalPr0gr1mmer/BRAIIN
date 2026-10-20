import { UUID, type Case } from '../harness';

// Website stats (§5 "Analytics — read dashboards", "Search analytics", "Analytics goals —
// set"; Admin v2 U2 and G1).

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
  {
    name: 'analytics realtime',
    load: () => import('@/pages/api/admin/analytics/realtime'),
    method: 'GET',
    url: '/api/admin/analytics/realtime',
    allow: ['admin', 'content_creator', 'seo', 'developer'],
  },
  // Goals (G1c): every analytics.read role reads them; analytics.goals (Admin, SEO) writes
  // and deletes them (the resource names `deleteCap: 'analytics.goals'`).
  {
    name: 'analytics goals list',
    load: () => import('@/pages/api/admin/analytics/goals/index'),
    method: 'GET',
    url: '/api/admin/analytics/goals',
    allow: ['admin', 'content_creator', 'seo', 'developer'],
  },
  {
    name: 'analytics goals create',
    load: () => import('@/pages/api/admin/analytics/goals/index'),
    method: 'POST',
    url: '/api/admin/analytics/goals',
    body: { name: 'WhatsApp clicks this month', metric: 'cta', cta: 'whatsapp', target: 50 },
    allow: ['admin', 'seo'],
  },
  {
    name: 'analytics goals read one',
    load: () => import('@/pages/api/admin/analytics/goals/[id]'),
    method: 'GET',
    url: `/api/admin/analytics/goals/${UUID}`,
    allow: ['admin', 'content_creator', 'seo', 'developer'],
  },
  {
    name: 'analytics goals update',
    load: () => import('@/pages/api/admin/analytics/goals/[id]'),
    method: 'PATCH',
    url: `/api/admin/analytics/goals/${UUID}`,
    body: { name: 'Visits this month', metric: 'visits', cta: null, target: 500, version: 1 },
    allow: ['admin', 'seo'],
  },
  {
    name: 'analytics goals delete (SEO may: not the content default)',
    load: () => import('@/pages/api/admin/analytics/goals/[id]'),
    method: 'DELETE',
    url: `/api/admin/analytics/goals/${UUID}`,
    allow: ['admin', 'seo'],
  },
];
