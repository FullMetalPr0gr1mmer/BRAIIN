import type { Case } from '../harness';

// Page visibility (Admin v2 U14a; §5 "Maintenance / hidden pages / page visibility",
// `maintenance.manage`: Admin + Developer). RLS agrees in both layers (0057, pgTAP
// supabase/tests/page_visibility.test.sql, the stale tokens included); the save re-reads the
// person first (liveRecheck), so a demoted Developer's next save is a 403 at once. The
// legacy toggle, now an alias over the same table, is in ./pages.ts.

export const cases: readonly Case[] = [
  {
    name: 'page visibility list',
    load: () => import('@/pages/api/admin/page-visibility/index'),
    method: 'GET',
    url: '/api/admin/page-visibility',
    allow: ['admin', 'developer'],
  },
  {
    name: 'page visibility save',
    load: () => import('@/pages/api/admin/page-visibility/index'),
    method: 'PUT',
    url: '/api/admin/page-visibility',
    body: { target: { template: 'service' }, mode: 'hidden', version: 1 },
    allow: ['admin', 'developer'],
  },
  {
    // The password's own door: the list's PUT takes the three modes that need no secret.
    // The password goes straight to public.set_page_password, which checks the live role
    // again inside the database (0061).
    name: 'page visibility set a password',
    load: () => import('@/pages/api/admin/page-visibility/password'),
    method: 'POST',
    url: '/api/admin/page-visibility/password',
    body: {
      pageId: '00000000-0000-4000-8000-0000000000a2',
      password: 'a-test-password',
      note: null,
      version: 1,
    },
    allow: ['admin', 'developer'],
  },
  {
    name: 'page visibility sync to edge',
    load: () => import('@/pages/api/admin/page-visibility/sync'),
    method: 'POST',
    url: '/api/admin/page-visibility/sync',
    allow: ['admin', 'developer'],
  },
];
