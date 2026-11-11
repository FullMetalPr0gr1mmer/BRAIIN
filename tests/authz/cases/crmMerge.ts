import { UUID, type Case } from '../harness';

// Merging duplicate contacts (Admin v2 C12, crm.md §9): every route needs `crm.contacts`, which
// is Admin's alone until C10b gives it to Sales (owner default O-7: Developer none), so every row
// allows Admin only. The finder and "Not a duplicate" run as the caller; the merge is the service
// role's door behind a live recheck and its own limit.

const OTHER = '33333333-3333-4333-8333-333333333333';

export const cases: readonly Case[] = [
  {
    name: 'likely duplicates (GET)',
    load: () => import('@/pages/api/admin/crm/duplicates/index'),
    method: 'GET',
    url: '/api/admin/crm/duplicates',
    allow: ['admin'],
    read: true,
  },
  {
    name: 'not a duplicate (POST dismiss)',
    load: () => import('@/pages/api/admin/crm/duplicates/dismiss'),
    method: 'POST',
    url: '/api/admin/crm/duplicates/dismiss',
    body: { a: UUID, b: OTHER },
    allow: ['admin'],
  },
  {
    name: 'merge two contacts (POST merge)',
    load: () => import('@/pages/api/admin/crm/contacts/merge'),
    method: 'POST',
    url: '/api/admin/crm/contacts/merge',
    body: { keepId: UUID, keepVersion: 1, dropId: OTHER, dropVersion: 1 },
    allow: ['admin'],
  },
];
