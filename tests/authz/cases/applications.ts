import { UUID, type Case } from '../harness';

// Job applications (Join) — Admin only, owner decision J6.

export const cases: readonly Case[] = [
  {
    name: 'applications list',
    load: () => import('@/pages/api/admin/applications/index'),
    method: 'GET',
    url: '/api/admin/applications',
    allow: ['admin'],
  },
  {
    name: 'application detail',
    load: () => import('@/pages/api/admin/applications/[id]'),
    method: 'GET',
    url: `/api/admin/applications/${UUID}`,
    allow: ['admin'],
  },
  {
    name: 'application contact details (pii)',
    load: () => import('@/pages/api/admin/applications/[id]'),
    method: 'GET',
    url: `/api/admin/applications/${UUID}?pii=1`,
    allow: ['admin'],
  },
  {
    name: 'application status / notes',
    load: () => import('@/pages/api/admin/applications/[id]'),
    method: 'PATCH',
    url: `/api/admin/applications/${UUID}`,
    body: { status: 'in_review', internalNotes: 'Strong reel' },
    allow: ['admin'],
  },
  {
    name: 'application erase',
    load: () => import('@/pages/api/admin/applications/[id]'),
    method: 'DELETE',
    url: `/api/admin/applications/${UUID}`,
    allow: ['admin'],
  },
  {
    name: 'application CV download',
    load: () => import('@/pages/api/admin/applications/[id]/cv'),
    method: 'GET',
    url: `/api/admin/applications/${UUID}/cv`,
    allow: ['admin'],
  },
];
