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
  // The legacy panel's save: a status needs leads.manage; internal notes are a leads.pii
  // column, so writing them adds that capability and a live recheck.
  {
    name: 'lead status (legacy panel)',
    load: () => import('@/pages/api/admin/leads/[id]'),
    method: 'PATCH',
    url: `/api/admin/leads/${UUID}`,
    body: { status: 'in_progress' },
    allow: ['admin', 'developer'],
  },
  {
    name: 'lead internal notes (legacy panel, leads.pii)',
    load: () => import('@/pages/api/admin/leads/[id]'),
    method: 'PATCH',
    url: `/api/admin/leads/${UUID}`,
    body: { internalNotes: 'Called back' },
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
    body: { q: 'acme', sort: 'newest' },
    allow: ['admin', 'developer'],
    read: true,
  },
  {
    name: 'lead pipeline board',
    load: () => import('@/pages/api/admin/leads/board'),
    method: 'POST',
    url: '/api/admin/leads/board',
    body: {},
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
