import type { Case } from '../harness';

// The dashboard's "needs attention" banners and headline counts.

export const cases: readonly Case[] = [
  {
    name: 'dashboard',
    load: () => import('@/pages/api/admin/dashboard'),
    method: 'GET',
    url: '/api/admin/dashboard',
    // analytics.read, which all four roles hold. What each one SEES is gated inside, per
    // capability: content rows, the open-lead count, the new-application count.
    allow: ['admin', 'content_creator', 'seo', 'developer'],
  },
];
