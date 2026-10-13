import type { Case } from '../harness';

// The signed-in person's own account (Admin v2 F8): their name, their password and their
// preferences. Every member may reach them; WHAT they change is their own row only, which
// the database decides (update_my_profile and admin_user_prefs' self-only RLS, 0044, in
// supabase/tests/personal_layer.test.sql). The password flow's own rules (re-authentication,
// the lockout, other sessions signed out, the audit rows) are in
// tests/lib/accountPassword.spec.ts.

const EVERY_ROLE: Case['allow'] = ['admin', 'content_creator', 'seo', 'developer'];

export const cases: readonly Case[] = [
  {
    name: 'my name',
    load: () => import('@/pages/api/admin/me/index'),
    method: 'PATCH',
    url: '/api/admin/me',
    body: { display_name: 'Sam Example' },
    allow: EVERY_ROLE,
  },
  {
    name: 'my password',
    load: () => import('@/pages/api/admin/me/password'),
    method: 'POST',
    url: '/api/admin/me/password',
    body: {
      current: 'an-old-password-1',
      next: 'a-new-password-22',
      confirm: 'a-new-password-22',
    },
    allow: EVERY_ROLE,
  },
  {
    name: 'my preferences read',
    load: () => import('@/pages/api/admin/me/preferences'),
    method: 'GET',
    url: '/api/admin/me/preferences',
    allow: EVERY_ROLE,
  },
  {
    name: 'my preferences save',
    load: () => import('@/pages/api/admin/me/preferences'),
    method: 'PUT',
    url: '/api/admin/me/preferences',
    body: { version: 1, notifications: { muted: ['scheduled'] } },
    allow: EVERY_ROLE,
  },
];
