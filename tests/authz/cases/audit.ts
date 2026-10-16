import type { Case } from '../harness';

// The activity log (§5 "Audit log — view", Admin + Developer) and its CSV export (Admin v2
// U13: §5 "Leads / analytics / activity — export CSV" and "Audit log — view", both held, so
// Admin + Developer).

export const cases: readonly Case[] = [
  {
    name: 'activity log export (CSV)',
    load: () => import('@/pages/api/admin/audit/export'),
    method: 'GET',
    url: '/api/admin/audit/export?kind=leads&from=2026-01-01',
    allow: ['admin', 'developer'],
  },
  {
    name: 'audit log read',
    load: () => import('@/pages/api/admin/audit'),
    method: 'GET',
    url: '/api/admin/audit',
    allow: ['admin', 'developer'],
  },
];
