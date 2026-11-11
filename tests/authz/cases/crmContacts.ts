import { UUID, type Case } from '../harness';

// The contacts API (Admin v2 C6, crm.md §9). `crm.contacts` is Admin's alone until C10b gives
// it to Sales (owner default O-7: Developer none), so every row allows Admin only. A new lead
// for a contact also needs `leads.manage` and `leads.pii`; deleting a note, the erasure
// preview and the erasure are `crm.erase` (Admin only). Developer and Sales hold leads.* and
// are refused here because neither holds crm.contacts or crm.erase.

const NOTE = '22222222-2222-4222-8222-222222222222';
const BASE = `/api/admin/crm/contacts/${UUID}`;

export const cases: readonly Case[] = [
  {
    name: 'contacts list (POST query)',
    load: () => import('@/pages/api/admin/crm/contacts/query'),
    method: 'POST',
    url: '/api/admin/crm/contacts/query',
    body: { stage: 'client', owner: 'me', q: 'Sara', limit: 25 },
    allow: ['admin'],
    read: true,
  },
  {
    name: 'contacts list searched by e-mail (blind index)',
    load: () => import('@/pages/api/admin/crm/contacts/query'),
    method: 'POST',
    url: '/api/admin/crm/contacts/query',
    body: { q: 'sara@example.test' },
    allow: ['admin'],
    read: true,
  },
  {
    name: 'contacts counts (POST summary)',
    load: () => import('@/pages/api/admin/crm/contacts/summary'),
    method: 'POST',
    url: '/api/admin/crm/contacts/summary',
    body: {},
    allow: ['admin'],
    read: true,
  },
  {
    // Admin v2 C7: the same counts as a GET, the People page's JSON twin for the refusal e2e.
    name: 'contacts counts (GET summary)',
    load: () => import('@/pages/api/admin/crm/contacts/summary'),
    method: 'GET',
    url: '/api/admin/crm/contacts/summary',
    allow: ['admin'],
    read: true,
  },
  {
    name: 'contacts picker (POST lookup)',
    load: () => import('@/pages/api/admin/crm/contacts/lookup'),
    method: 'POST',
    url: '/api/admin/crm/contacts/lookup',
    body: { q: 'Sara' },
    allow: ['admin'],
    read: true,
  },
  {
    name: 'contact added by hand',
    load: () => import('@/pages/api/admin/crm/contacts/index'),
    method: 'POST',
    url: '/api/admin/crm/contacts',
    body: {
      displayName: 'Sara',
      channels: [{ kind: 'email', value: 'sara@example.test', isPrimary: true }],
    },
    allow: ['admin'],
  },
  {
    name: 'contact detail',
    load: () => import('@/pages/api/admin/crm/contacts/[id]'),
    method: 'GET',
    url: BASE,
    allow: ['admin'],
  },
  {
    name: 'contact details change (versioned PATCH)',
    load: () => import('@/pages/api/admin/crm/contacts/[id]'),
    method: 'PATCH',
    url: BASE,
    body: { version: 1, stage: 'client', tags: ['VIP'] },
    allow: ['admin'],
  },
  {
    name: 'contact star (unversioned PATCH)',
    load: () => import('@/pages/api/admin/crm/contacts/[id]'),
    method: 'PATCH',
    url: BASE,
    body: { isStarred: true },
    allow: ['admin'],
  },
  {
    name: 'contact e-mails and phones change (PATCH channels)',
    load: () => import('@/pages/api/admin/crm/contacts/[id]'),
    method: 'PATCH',
    url: BASE,
    body: { version: 1, channels: { add: [{ kind: 'phone', value: '+966501234567' }] } },
    allow: ['admin'],
  },
  {
    name: 'contact contact details (reveal)',
    load: () => import('@/pages/api/admin/crm/contacts/[id]/reveal'),
    method: 'POST',
    url: `${BASE}/reveal`,
    allow: ['admin'],
  },
  {
    name: 'contact notes (read)',
    load: () => import('@/pages/api/admin/crm/contacts/[id]/notes'),
    method: 'GET',
    url: `${BASE}/notes`,
    allow: ['admin'],
  },
  {
    name: 'contact notes (add)',
    load: () => import('@/pages/api/admin/crm/contacts/[id]/notes'),
    method: 'POST',
    url: `${BASE}/notes`,
    body: { body: 'Met at the expo.' },
    allow: ['admin'],
  },
  {
    name: 'contact note delete (crm.erase, Admin only)',
    load: () => import('@/pages/api/admin/crm/contacts/[id]/notes/[noteId]'),
    method: 'DELETE',
    url: `${BASE}/notes/${NOTE}`,
    params: { noteId: NOTE },
    allow: ['admin'],
  },
  {
    name: 'contact timeline',
    load: () => import('@/pages/api/admin/crm/contacts/[id]/timeline'),
    method: 'GET',
    url: `${BASE}/timeline?kind=notes&limit=30`,
    allow: ['admin'],
  },
  {
    name: 'contacts bulk change',
    load: () => import('@/pages/api/admin/crm/contacts/bulk'),
    method: 'POST',
    url: '/api/admin/crm/contacts/bulk',
    body: { action: 'stage', value: 'client', items: [{ id: UUID, version: 1 }] },
    allow: ['admin'],
  },
  {
    name: 'contact phone match check (confirm or detach)',
    load: () => import('@/pages/api/admin/crm/contacts/[id]/links'),
    method: 'POST',
    url: `${BASE}/links`,
    body: { leadId: NOTE, action: 'confirm' },
    allow: ['admin'],
  },
  {
    name: 'contact new lead (crm.contacts + leads.manage + leads.pii)',
    load: () => import('@/pages/api/admin/crm/contacts/[id]/leads'),
    method: 'POST',
    url: `${BASE}/leads`,
    body: { message: 'Wants a brand refresh', channel: 'phone' },
    allow: ['admin'],
  },
  {
    name: 'contact erase preview (crm.erase, Admin only)',
    load: () => import('@/pages/api/admin/crm/contacts/[id]/erase-preview'),
    method: 'POST',
    url: `${BASE}/erase-preview`,
    allow: ['admin'],
  },
  {
    name: 'contact erase (crm.erase, Admin only)',
    load: () => import('@/pages/api/admin/crm/contacts/[id]/erase'),
    method: 'POST',
    url: `${BASE}/erase`,
    body: { reason: 'dsar', extraLeads: [NOTE] },
    allow: ['admin'],
  },
];
