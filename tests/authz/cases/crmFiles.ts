import { UUID, type Case } from '../harness';

// Contact files (Admin v2 C16, crm.md §12). `crm.files` is Admin's alone (Developer none, owner
// default O-7; Sales none unless C10b's design gives it), so every row allows Admin only.
// Developer and Sales hold leads.* and are refused here because neither holds crm.files. The
// upload's body is a multipart form; the gate runs before the body is read, so the rows send
// none.

const BASE = `/api/admin/crm/contacts/${UUID}/files`;

export const cases: readonly Case[] = [
  {
    name: 'contact files list',
    load: () => import('@/pages/api/admin/crm/contacts/[id]/files'),
    method: 'GET',
    url: BASE,
    allow: ['admin'],
    read: true,
  },
  {
    name: 'contact file upload',
    load: () => import('@/pages/api/admin/crm/contacts/[id]/files'),
    method: 'POST',
    url: BASE,
    allow: ['admin'],
  },
  {
    name: 'contact file download',
    load: () => import('@/pages/api/admin/crm/contacts/[id]/files/[fileId]'),
    method: 'GET',
    url: `${BASE}/${UUID}`,
    params: { fileId: UUID },
    allow: ['admin'],
    read: true,
  },
  {
    name: 'contact file removed',
    load: () => import('@/pages/api/admin/crm/contacts/[id]/files/[fileId]'),
    method: 'DELETE',
    url: `${BASE}/${UUID}`,
    params: { fileId: UUID },
    allow: ['admin'],
  },
];
