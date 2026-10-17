import type { Case } from '../harness';

// The dashboard (Admin v2 U1): its JSON twin, the shared team notes and the owner's presets
// per role. The board and the notes are analytics.read's (all four roles); WHAT each role
// sees is gated inside, per capability (the widget registry, src/lib/admin/dashboard), and
// by RLS. The presets are users.manage's (Admin), as the database's write policies are the
// live Admin's (admin_role_defaults, 0060, in supabase/tests/dashboard_layer.test.sql).

const EVERY_ROLE: Case['allow'] = ['admin', 'content_creator', 'seo', 'developer'];

export const cases: readonly Case[] = [
  {
    name: 'dashboard',
    load: () => import('@/pages/api/admin/dashboard'),
    method: 'GET',
    url: '/api/admin/dashboard',
    // analytics.read, which all four roles hold. What each one SEES is gated inside, per
    // capability: content rows, the lead figures, the new-application count.
    allow: EVERY_ROLE,
  },
  {
    name: 'team notes read',
    load: () => import('@/pages/api/admin/dashboard/notes'),
    method: 'GET',
    url: '/api/admin/dashboard/notes',
    allow: EVERY_ROLE,
  },
  {
    name: 'team notes save',
    load: () => import('@/pages/api/admin/dashboard/notes'),
    method: 'PATCH',
    url: '/api/admin/dashboard/notes',
    body: { version: 1, body: 'Shoot moved to the 14th.' },
    allow: EVERY_ROLE,
  },
  {
    name: 'role defaults read',
    load: () => import('@/pages/api/admin/dashboard/defaults/index'),
    method: 'GET',
    url: '/api/admin/dashboard/defaults',
    allow: ['admin'],
  },
  {
    name: 'role defaults save',
    load: () => import('@/pages/api/admin/dashboard/defaults/[role]'),
    method: 'PUT',
    url: '/api/admin/dashboard/defaults/seo',
    // The route reads `[role]`: without it every principal past assertCap would get 404 and
    // the handler, its tenant scoping and its audit row would never run here.
    params: { role: 'seo' },
    body: { version: 0, quickActions: [{ id: 'edit-seo' }] },
    allow: ['admin'],
  },
  {
    name: 'role defaults reset',
    load: () => import('@/pages/api/admin/dashboard/defaults/[role]'),
    method: 'DELETE',
    url: '/api/admin/dashboard/defaults/seo',
    params: { role: 'seo' },
    allow: ['admin'],
  },
];
