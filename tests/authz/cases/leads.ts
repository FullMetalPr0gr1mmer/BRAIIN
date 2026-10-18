import { UUID, type Case } from '../harness';

// Leads / PII (§5 "Leads", Admin + Developer): the legacy panel's routes, the CRM read
// side (Admin v2 C2a) and one lead in the CRM (C2b). Content Creator and SEO get no lead
// access at all.

export const cases: readonly Case[] = [
  {
    name: 'leads list',
    load: () => import('@/pages/api/admin/leads/index'),
    method: 'GET',
    url: '/api/admin/leads',
    allow: ['admin', 'developer'],
  },
  {
    name: 'lead detail',
    load: () => import('@/pages/api/admin/leads/[id]'),
    method: 'GET',
    url: `/api/admin/leads/${UUID}`,
    allow: ['admin', 'developer'],
  },
  // The legacy panel's status save, kept for an old tab until C14: leads.manage. The legacy
  // notes field is refused (422) for every role since C4b (tests/lib/leadsWrite.spec.ts).
  {
    name: 'lead status (legacy panel)',
    load: () => import('@/pages/api/admin/leads/[id]'),
    method: 'PATCH',
    url: `/api/admin/leads/${UUID}`,
    body: { status: 'in_progress' },
    allow: ['admin', 'developer'],
  },
  {
    name: 'lead CSV export',
    load: () => import('@/pages/api/admin/leads/export'),
    method: 'GET',
    url: '/api/admin/leads/export',
    allow: ['admin', 'developer'],
  },
  // CRM read side (Admin v2 C2a): leads.manage, like the list.
  {
    name: 'lead query (CRM list)',
    load: () => import('@/pages/api/admin/leads/query'),
    method: 'POST',
    url: '/api/admin/leads/query',
    // C4a's keys too (0063), so the matrix runs them: 'me' is resolved in SQL.
    body: { q: 'acme', sort: 'newest', assigned: 'me', starred: true },
    allow: ['admin', 'developer'],
    read: true,
  },
  {
    name: 'lead pipeline board',
    load: () => import('@/pages/api/admin/leads/board'),
    method: 'POST',
    url: '/api/admin/leads/board',
    body: { assigned: 'none' },
    allow: ['admin', 'developer'],
    read: true,
  },
  {
    name: 'lead KPIs',
    load: () => import('@/pages/api/admin/leads/summary'),
    method: 'POST',
    url: '/api/admin/leads/summary',
    body: {},
    allow: ['admin', 'developer'],
    read: true,
  },
  // One lead in the CRM (Admin v2 C2b): contact details and notes are leads.pii.
  {
    name: 'lead contact reveal',
    load: () => import('@/pages/api/admin/leads/[id]/reveal'),
    method: 'POST',
    url: `/api/admin/leads/${UUID}/reveal`,
    allow: ['admin', 'developer'],
  },
  {
    name: 'lead notes thread (read)',
    load: () => import('@/pages/api/admin/leads/[id]/notes'),
    method: 'GET',
    url: `/api/admin/leads/${UUID}/notes`,
    allow: ['admin', 'developer'],
  },
  {
    name: 'lead notes thread (add)',
    load: () => import('@/pages/api/admin/leads/[id]/notes'),
    method: 'POST',
    url: `/api/admin/leads/${UUID}/notes`,
    body: { body: 'Called back' },
    allow: ['admin', 'developer'],
  },
  {
    name: 'lead timeline',
    load: () => import('@/pages/api/admin/leads/[id]/events'),
    method: 'GET',
    url: `/api/admin/leads/${UUID}/events`,
    allow: ['admin', 'developer'],
  },
];
