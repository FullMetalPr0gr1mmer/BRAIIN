import { UUID, type Case } from '../harness';

// Tasks (Admin v2 C8, crm.md §9). `crm.tasks` is Admin's and, since C10b, Sales' (owner
// default O-7: Developer none), so every row allows Admin and Sales. Developer holds leads.*
// and is refused here because it does not hold crm.tasks.

const BASE = `/api/admin/crm/tasks/${UUID}`;

export const cases: readonly Case[] = [
  {
    name: 'tasks list (grouped)',
    load: () => import('@/pages/api/admin/crm/tasks/index'),
    method: 'GET',
    url: '/api/admin/crm/tasks?view=mine',
    allow: ['admin', 'sales'],
    read: true,
  },
  {
    name: 'tasks of one lead',
    load: () => import('@/pages/api/admin/crm/tasks/index'),
    method: 'GET',
    url: `/api/admin/crm/tasks?lead=${UUID}`,
    allow: ['admin', 'sales'],
    read: true,
  },
  {
    name: 'task added',
    load: () => import('@/pages/api/admin/crm/tasks/index'),
    method: 'POST',
    url: '/api/admin/crm/tasks',
    body: { title: 'Call back', type: 'call', dueDate: '2026-11-11', dueTime: '10:00' },
    allow: ['admin', 'sales'],
  },
  {
    name: 'one task read again (the drawer after a 409)',
    load: () => import('@/pages/api/admin/crm/tasks/[id]'),
    method: 'GET',
    url: BASE,
    allow: ['admin', 'sales'],
    read: true,
  },
  {
    name: 'task edit (versioned PATCH)',
    load: () => import('@/pages/api/admin/crm/tasks/[id]'),
    method: 'PATCH',
    url: BASE,
    body: { version: 1, title: 'Call back, again' },
    allow: ['admin', 'sales'],
  },
  {
    name: 'task ticked done (unversioned PATCH)',
    load: () => import('@/pages/api/admin/crm/tasks/[id]'),
    method: 'PATCH',
    url: BASE,
    body: { done: true },
    allow: ['admin', 'sales'],
  },
  {
    name: 'task snoozed to tomorrow 10:00',
    load: () => import('@/pages/api/admin/crm/tasks/[id]'),
    method: 'PATCH',
    url: BASE,
    body: { version: 1, snooze: 'tomorrow_10' },
    allow: ['admin', 'sales'],
  },
  {
    name: 'task removed',
    load: () => import('@/pages/api/admin/crm/tasks/[id]'),
    method: 'DELETE',
    url: BASE,
    body: { version: 1 },
    allow: ['admin', 'sales'],
  },
  {
    name: 'task calendar file (.ics)',
    load: () => import('@/pages/api/admin/crm/tasks/[id]/ics'),
    method: 'GET',
    url: `${BASE}/ics`,
    allow: ['admin', 'sales'],
    read: true,
  },
];
