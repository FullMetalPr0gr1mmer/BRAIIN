import { UUID, type Case } from '../harness';

// Users & roles (§5 "Users & roles", Admin only). The Security card and "Make account owner"
// are Admin v2 U12a's; Resend and Cancel of an invite are U12b's. The invite and the resend
// answer 503 `not-set-up` after the gate while e-mail is off (the stubs' AUTH_EMAIL_READY);
// tests/lib/usersApi.spec.ts drives them switched on.

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
  {
    name: 'user security settings read',
    load: () => import('@/pages/api/admin/users/security'),
    method: 'GET',
    url: '/api/admin/users/security',
    allow: ['admin'],
  },
  {
    name: 'user security settings save',
    load: () => import('@/pages/api/admin/users/security'),
    method: 'PUT',
    url: '/api/admin/users/security',
    body: { sessionMaxDays: 1, inviteDomain: 'example.test', version: 1 },
    allow: ['admin'],
  },
  {
    name: 'user invite resend',
    load: () => import('@/pages/api/admin/users/[id]/resend'),
    method: 'POST',
    url: `/api/admin/users/${UUID}/resend`,
    allow: ['admin'],
  },
  {
    name: 'user invite cancel',
    load: () => import('@/pages/api/admin/users/[id]/invite'),
    method: 'DELETE',
    url: `/api/admin/users/${UUID}/invite`,
    allow: ['admin'],
  },
  {
    // The owner rule comes after the gate: an Admin who is not the owner (the stub's) is a
    // 422, never a 403 (tests/lib/usersApi.spec.ts drives the owner's own transfer).
    name: 'user ownership transfer',
    load: () => import('@/pages/api/admin/users/[id]/owner'),
    method: 'POST',
    url: `/api/admin/users/${UUID}/owner`,
    allow: ['admin'],
  },
];
