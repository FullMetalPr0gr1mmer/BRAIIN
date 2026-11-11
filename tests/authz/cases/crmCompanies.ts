import { UUID, type Case } from '../harness';

// Companies (Admin v2 C11, crm.md §9). `crm.contacts` covers "contacts & companies" (crm.md
// §2.1): Admin's alone on this base (owner default O-7: Developer none). When C10b gives Sales
// crm.contacts, its merge adds 'sales' to every row here, as it does to crmContacts.ts.

const BASE = `/api/admin/crm/companies/${UUID}`;

export const cases: readonly Case[] = [
  {
    name: 'companies list (POST query)',
    load: () => import('@/pages/api/admin/crm/companies/query'),
    method: 'POST',
    url: '/api/admin/crm/companies/query',
    body: { q: 'acme', sort: 'name', limit: 25 },
    allow: ['admin'],
    read: true,
  },
  {
    name: 'company added',
    load: () => import('@/pages/api/admin/crm/companies/index'),
    method: 'POST',
    url: '/api/admin/crm/companies',
    body: { name: 'Acme Trading', website: 'https://acme.example', stage: 'client' },
    allow: ['admin'],
  },
  {
    name: 'company read (the drawer)',
    load: () => import('@/pages/api/admin/crm/companies/[id]'),
    method: 'GET',
    url: BASE,
    allow: ['admin'],
    read: true,
  },
  {
    name: 'company change (versioned PATCH)',
    load: () => import('@/pages/api/admin/crm/companies/[id]'),
    method: 'PATCH',
    url: BASE,
    body: { version: 1, city: 'Jeddah' },
    allow: ['admin'],
  },
  {
    name: 'company removed',
    load: () => import('@/pages/api/admin/crm/companies/[id]'),
    method: 'DELETE',
    url: BASE,
    body: { version: 1 },
    allow: ['admin'],
  },
  {
    name: "contact's company linked",
    load: () => import('@/pages/api/admin/crm/contacts/[id]/company'),
    method: 'POST',
    url: `/api/admin/crm/contacts/${UUID}/company`,
    body: { action: 'link', version: 1, companyId: UUID },
    allow: ['admin'],
  },
  {
    name: "contact's company made from its name",
    load: () => import('@/pages/api/admin/crm/contacts/[id]/company'),
    method: 'POST',
    url: `/api/admin/crm/contacts/${UUID}/company`,
    body: { action: 'create', version: 1 },
    allow: ['admin'],
  },
];
