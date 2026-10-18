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
    // Check now (Admin v2 G2): the screen's capability. Allowed roles reach the probe runner
    // (endpoints.spec.ts stubs the launch tenant to theirs, and every outbound fetch rejects),
    // whose reads fail and are recorded, still a non-403.
    name: 'site health check',
    load: () => import('@/pages/api/admin/site-health/check'),
    method: 'POST',
    url: '/api/admin/site-health/check',
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
