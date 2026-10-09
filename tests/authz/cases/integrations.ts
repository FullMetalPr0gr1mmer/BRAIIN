import type { Case } from '../harness';

// Settings › Integrations (§5 "Integrations", Admin + SEO): GA4, Search Console, Calendly,
// reCAPTCHA. Its own table, site_integrations, because RLS is row-level (§2 amendment).

export const cases: readonly Case[] = [
  {
    name: 'integrations read',
    load: () => import('@/pages/api/admin/integrations'),
    method: 'GET',
    url: '/api/admin/integrations',
    // What the form loads on mount, and what tests/admin/refusals.e2e.ts asks the real
    // stack for as each role without the capability.
    allow: ['admin', 'seo'],
  },
  {
    name: 'integrations write',
    load: () => import('@/pages/api/admin/integrations'),
    method: 'PATCH',
    url: '/api/admin/integrations',
    body: { ga4: {}, version: 1 },
    allow: ['admin', 'seo'],
  },
];
