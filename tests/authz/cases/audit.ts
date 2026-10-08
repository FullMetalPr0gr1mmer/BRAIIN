import type { Case } from '../harness';

// The activity log (§5 "Audit log — view", Admin + Developer).

export const cases: readonly Case[] = [
  {
    name: 'audit log read',
    load: () => import('@/pages/api/admin/audit'),
    method: 'GET',
    url: '/api/admin/audit',
    allow: ['admin', 'developer'],
  },
];
