import { UUID, type Case } from '../harness';

// Users & roles (§5 "Users & roles", Admin only).

export const cases: readonly Case[] = [
  {
    name: 'user list',
    load: () => import('@/pages/api/admin/users/index'),
    method: 'GET',
    url: '/api/admin/users',
    allow: ['admin'],
  },
  {
    name: 'user invite',
    load: () => import('@/pages/api/admin/users/index'),
    method: 'POST',
    url: '/api/admin/users',
    body: { email: 'new@example.test', role: 'seo' },
    allow: ['admin'],
  },
  {
    // The harness's caller and target share one id, and changing your own role is refused
    // (422) after the gate, so this row edits a name. Every PATCH passes `users.manage`
    // and the live recheck first, whatever it changes.
    name: 'user update',
    load: () => import('@/pages/api/admin/users/[id]'),
    method: 'PATCH',
    url: `/api/admin/users/${UUID}`,
    body: { displayName: 'Sam Example' },
    allow: ['admin'],
  },
];
