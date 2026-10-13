import type { Case } from '../harness';

// The bell (Admin v2 F8): every member has one. Which ITEMS each role gets is decided per
// source from ROLE_CAPS and pinned role by role in tests/lib/notifications.spec.ts
// (Content Creator and SEO get no lead or application item, not even a count).

export const cases: readonly Case[] = [
  {
    name: 'the bell list',
    load: () => import('@/pages/api/admin/notifications/index'),
    method: 'GET',
    url: '/api/admin/notifications',
    allow: ['admin', 'content_creator', 'seo', 'developer'],
  },
  {
    name: 'mark all read',
    load: () => import('@/pages/api/admin/notifications/seen'),
    method: 'POST',
    url: '/api/admin/notifications/seen',
    // Up to when the list the person was shown was read (the feed's `asOf`).
    body: { asOf: '2026-10-10T12:00:00.000Z' },
    allow: ['admin', 'content_creator', 'seo', 'developer'],
  },
];
