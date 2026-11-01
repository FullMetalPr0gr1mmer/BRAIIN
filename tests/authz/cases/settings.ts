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
    // Admin v2 U9: the studio's time zone (the technical `identity` JSON left the form).
    body: { timezone: 'Asia/Riyadh', version: 1 },
    allow: ['admin', 'developer'],
  },
  {
    // A shortened retention is a purge: the same two roles, and the live check in the DB.
    name: 'general settings write, retention',
    load: () => import('@/pages/api/admin/settings/index'),
    method: 'PATCH',
    url: '/api/admin/settings',
    body: { retention: { spam_days: 30 }, version: 1 },
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
  // The forms config (Admin v2 E8, form_settings): §5 "General settings", Admin + Developer.
  {
    name: 'forms config read',
    load: () => import('@/pages/api/admin/form-settings'),
    method: 'GET',
    url: '/api/admin/form-settings',
    allow: ['admin', 'developer'],
  },
  {
    name: 'forms config write',
    load: () => import('@/pages/api/admin/form-settings'),
    method: 'PATCH',
    url: '/api/admin/form-settings',
    body: { inquiry: { button: VALID_BILINGUAL }, version: 1 },
    allow: ['admin', 'developer'],
  },
  {
    // Admin v2 U9: the identity's new contact and brand fields, and a hidden social account.
    name: 'site profile write, contact and brand',
    load: () => import('@/pages/api/admin/site-profile'),
    method: 'PATCH',
    url: '/api/admin/site-profile',
    body: {
      tagline: VALID_BILINGUAL,
      phoneE164: '+966500000001',
      mapUrl: 'https://maps.app.goo.gl/abc',
      socials: [
        {
          network: 'instagram',
          handle: '@example',
          url: 'https://instagram.com/example',
          visible: false,
        },
      ],
      version: 1,
    },
    allow: ['admin', 'developer'],
  },
  {
    // The footer settings E6 edits are stored here, with the same gate.
    name: 'site profile write, footer settings',
    load: () => import('@/pages/api/admin/site-profile'),
    method: 'PATCH',
    url: '/api/admin/site-profile',
    body: { footerShowEmail: true, version: 1 },
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
    // Maintenance v2 (Admin v2 U9b): the whole value, the staff bypass included.
    name: 'maintenance toggle',
    load: () => import('@/pages/api/admin/settings/maintenance'),
    method: 'PATCH',
    url: '/api/admin/settings/maintenance',
    body: {
      active: false,
      allowlist: [],
      staffBypass: true,
      until: null,
      showDate: false,
      background: 'image',
      showContact: true,
      title: null,
      message: null,
      version: 1,
    },
    allow: ['admin', 'developer'],
  },
  {
    // "Preview full screen": the saved page, as HTML, for the same two roles.
    name: 'maintenance preview',
    load: () => import('@/pages/api/admin/settings/maintenance/preview'),
    method: 'GET',
    url: '/api/admin/settings/maintenance/preview?lang=en',
    allow: ['admin', 'developer'],
  },
];
