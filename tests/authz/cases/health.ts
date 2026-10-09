import type { Case } from '../harness';

// Site health and its error log (§5 "Site Health & Performance panel", "System logs").

export const cases: readonly Case[] = [
  {
    name: 'site health',
    load: () => import('@/pages/api/admin/site-health'),
    method: 'GET',
    url: '/api/admin/site-health',
    allow: ['admin', 'developer'],
  },
  {
    name: 'system logs read',
    load: () => import('@/pages/api/admin/logs'),
    method: 'GET',
    url: '/api/admin/logs',
    allow: ['admin', 'developer'],
  },
  {
    name: 'system logs clear',
    load: () => import('@/pages/api/admin/logs'),
    method: 'DELETE',
    url: '/api/admin/logs?olderThanDays=30',
    allow: ['admin'],
  },
];
