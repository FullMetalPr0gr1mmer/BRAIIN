import { UUID, type Case } from '../harness';

// Leads / PII (§5 "Leads", Admin + Developer, and Sales since Admin v2 C10a): the legacy
// panel's routes, the CRM read side (Admin v2 C2a) and one lead in the CRM (C2b). Content
// Creator and SEO get no lead access at all; Sales gets no export (export.csv).

export const cases: readonly Case[] = [
  {
    name: 'leads list',
    load: () => import('@/pages/api/admin/leads/index'),
    method: 'GET',
    url: '/api/admin/leads',
    allow: ['admin', 'developer', 'sales'],
  },
  {
    name: 'lead detail',
    load: () => import('@/pages/api/admin/leads/[id]'),
    method: 'GET',
    url: `/api/admin/leads/${UUID}`,
    allow: ['admin', 'developer', 'sales'],
  },
  // The legacy panel's status save: leads.manage, then refused (422) for every role since
  // C10a, as the legacy notes field is since C4b (tests/lib/leadsWrite.spec.ts).
  {
    name: 'lead status (legacy panel)',
    load: () => import('@/pages/api/admin/leads/[id]'),
    method: 'PATCH',
    url: `/api/admin/leads/${UUID}`,
    body: { status: 'in_progress' },
    allow: ['admin', 'developer', 'sales'],
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
    allow: ['admin', 'developer', 'sales'],
    read: true,
  },
  {
    name: 'lead pipeline board',
    load: () => import('@/pages/api/admin/leads/board'),
    method: 'POST',
    url: '/api/admin/leads/board',
    body: { assigned: 'none' },
    allow: ['admin', 'developer', 'sales'],
    read: true,
  },
  // The Services area's per-service counts (Admin v2 U5): counts only, the leads caps.
  {
    name: 'lead interest counts (per service)',
    load: () => import('@/pages/api/admin/leads/interest-counts'),
    method: 'GET',
    url: '/api/admin/leads/interest-counts',
    allow: ['admin', 'developer', 'sales'],
  },
  {
    name: 'lead KPIs',
    load: () => import('@/pages/api/admin/leads/summary'),
    method: 'POST',
    url: '/api/admin/leads/summary',
    body: {},
    allow: ['admin', 'developer', 'sales'],
    read: true,
  },
  // One lead in the CRM (Admin v2 C2b): contact details and notes are leads.pii.
  {
    name: 'lead contact reveal',
    load: () => import('@/pages/api/admin/leads/[id]/reveal'),
    method: 'POST',
    url: `/api/admin/leads/${UUID}/reveal`,
    allow: ['admin', 'developer', 'sales'],
  },
  {
    name: 'lead notes thread (read)',
    load: () => import('@/pages/api/admin/leads/[id]/notes'),
    method: 'GET',
    url: `/api/admin/leads/${UUID}/notes`,
    allow: ['admin', 'developer', 'sales'],
  },
  {
    name: 'lead notes thread (add)',
    load: () => import('@/pages/api/admin/leads/[id]/notes'),
    method: 'POST',
    url: `/api/admin/leads/${UUID}/notes`,
    body: { body: 'Called back' },
    allow: ['admin', 'developer', 'sales'],
  },
  {
    name: 'lead timeline',
    load: () => import('@/pages/api/admin/leads/[id]/events'),
    method: 'GET',
    url: `/api/admin/leads/${UUID}/events`,
    allow: ['admin', 'developer', 'sales'],
  },
];
