import { UUID, type Case } from '../harness';

// Merging duplicate contacts (Admin v2 C12, crm.md §9 and CRM-12: "admin and sales allowed"):
// every route needs `crm.contacts`, Admin's and, since C10b, Sales' (owner default O-7:
// Developer none), so the C10b + C12 integration (C-int) allows both on every row. The finder and
// "Not a duplicate" run as the caller; the merge is the service role's door behind a live
// recheck, a reveal slot for Sales (crmMerge.spec) and its own limit.

const OTHER = '33333333-3333-4333-8333-333333333333';

export const cases: readonly Case[] = [
  {
    name: 'likely duplicates (GET)',
    load: () => import('@/pages/api/admin/crm/duplicates/index'),
    method: 'GET',
    url: '/api/admin/crm/duplicates',
    allow: ['admin', 'sales'],
    read: true,
  },
  {
    name: 'not a duplicate (POST dismiss)',
    load: () => import('@/pages/api/admin/crm/duplicates/dismiss'),
    method: 'POST',
    url: '/api/admin/crm/duplicates/dismiss',
    body: { a: UUID, b: OTHER },
    allow: ['admin', 'sales'],
  },
  {
    name: 'merge two contacts (POST merge)',
    load: () => import('@/pages/api/admin/crm/contacts/merge'),
    method: 'POST',
    url: '/api/admin/crm/contacts/merge',
    body: { keepId: UUID, keepVersion: 1, dropId: OTHER, dropVersion: 1 },
    allow: ['admin', 'sales'],
  },
];
