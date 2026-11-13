import { UUID, type Case } from '../harness';

// The CSV import of contacts (Admin v2 C15, crm.md §12). `crm.import` is Admin's alone: every
// row allows Admin only. Developer and Sales hold leads.* and are refused here, as are
// Content Creator, SEO, anon and another tenant's Admin.

const URL = '/api/admin/crm/contacts/import';
const load = () => import('@/pages/api/admin/crm/contacts/import/index');

export const cases: readonly Case[] = [
  {
    name: 'contacts import opened (attempt audited first)',
    load,
    method: 'POST',
    url: URL,
    body: { step: 'open', rows: 3, bytes: 300, attested: true },
    allow: ['admin'],
  },
  {
    name: 'contacts import piece (parsed on the server)',
    load,
    method: 'POST',
    url: URL,
    body: {
      step: 'rows',
      batchId: UUID,
      rowNumbers: [2],
      csv: 'name,email,lawful_basis\nSara,sara@example.test,consent\n',
    },
    allow: ['admin'],
  },
  {
    name: 'contacts import finished (outcome audited)',
    load,
    method: 'POST',
    url: URL,
    body: { step: 'finish', batchId: UUID },
    allow: ['admin'],
  },
  {
    // The import screen's JSON twin: the recent imports, counts only.
    name: 'contacts imports list',
    load,
    method: 'GET',
    url: URL,
    allow: ['admin'],
  },
  {
    name: 'contacts import template (CSV)',
    load: () => import('@/pages/api/admin/crm/contacts/import/template'),
    method: 'GET',
    url: `${URL}/template`,
    allow: ['admin'],
  },
];
