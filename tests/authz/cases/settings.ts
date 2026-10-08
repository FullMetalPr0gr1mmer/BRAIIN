import { VALID_BILINGUAL, type Case } from '../harness';

// Settings › General: the technical settings row, the public identity (site_profile) and
// maintenance mode (§5 "General settings", "Maintenance / hidden pages / page visibility",
// both Admin + Developer).

export const cases: readonly Case[] = [
  {
    name: 'general settings read',
    load: () => import('@/pages/api/admin/settings/index'),
    method: 'GET',
    url: '/api/admin/settings',
    // What the form loads on mount, and what tests/admin/refusals.e2e.ts asks the real
    // stack for as each role without the capability.
    allow: ['admin', 'developer'],
  },
  {
    name: 'general settings write',
    load: () => import('@/pages/api/admin/settings/index'),
    method: 'PATCH',
    url: '/api/admin/settings',
    body: { identity: {}, version: 1 },
    allow: ['admin', 'developer'],
  },
  // Public identity singleton (migration 0019) — §5 "General settings": Admin + Developer.
  // (accepting_applications is narrower still — Admin only — but that is enforced by the
  // DATABASE, a 0019 trigger, and pinned by supabase/tests/rls_site_profile.test.sql.)
  {
    name: 'site profile read',
    load: () => import('@/pages/api/admin/site-profile'),
    method: 'GET',
    url: '/api/admin/site-profile',
    allow: ['admin', 'developer'],
  },
  {
    name: 'site profile write',
    load: () => import('@/pages/api/admin/site-profile'),
    method: 'PATCH',
    url: '/api/admin/site-profile',
    body: { brandName: VALID_BILINGUAL, version: 1 },
    allow: ['admin', 'developer'],
  },
  {
    // The settings form ALWAYS sends the checkbox, so an unchanged flag must not turn a
    // Developer's identity save into a 403. (The stubbed stored row has it closed.)
    name: 'site profile write, applications flag unchanged',
    load: () => import('@/pages/api/admin/site-profile'),
    method: 'PATCH',
    url: '/api/admin/site-profile',
    body: { brandName: VALID_BILINGUAL, acceptingApplications: false, version: 1 },
    allow: ['admin', 'developer'],
  },
  {
    // Opening the job-application intake is Admin-only (UI v2 decision 4). This row is
    // the WORKER layer; the 0019 guard trigger is the database layer (pgTAP).
    name: 'site profile opens job applications (Admin-only)',
    load: () => import('@/pages/api/admin/site-profile'),
    method: 'PATCH',
    url: '/api/admin/site-profile',
    body: { acceptingApplications: true, version: 1 },
    allow: ['admin'],
  },
  {
    name: 'maintenance read',
    load: () => import('@/pages/api/admin/settings/maintenance'),
    method: 'GET',
    url: '/api/admin/settings/maintenance',
    allow: ['admin', 'developer'],
  },
  {
    name: 'maintenance toggle',
    load: () => import('@/pages/api/admin/settings/maintenance'),
    method: 'PATCH',
    url: '/api/admin/settings/maintenance',
    body: { active: true, allowlist: ['203.0.113.4'], version: 1 },
    allow: ['admin', 'developer'],
  },
];
