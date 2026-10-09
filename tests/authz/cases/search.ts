import type { Case } from '../harness';

// The command palette's admin search. Who may call it is this row; what each role FINDS
// is pinned in endpoints.spec.ts ("searches as its caller") and tests/lib/globalSearch.spec.ts.

export const cases: readonly Case[] = [
  {
    name: 'admin search (the command palette)',
    load: () => import('@/pages/api/admin/search'),
    method: 'GET',
    url: '/api/admin/search?q=logo',
    // Any staff role: what each one FINDS is gated per entity inside searchAdmin().
    allow: ['admin', 'content_creator', 'seo', 'developer'],
  },
];
