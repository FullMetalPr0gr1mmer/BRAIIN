import type { Case } from '../harness';

// Backup export (§5 "Backup export", Admin + Developer; the export lockdown, §7).

export const cases: readonly Case[] = [
  {
    name: 'backup export',
    load: () => import('@/pages/api/admin/export-backup'),
    method: 'GET',
    url: '/api/admin/export-backup',
    allow: ['admin', 'developer'],
  },
];
