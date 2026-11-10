import { UUID, type Case } from '../harness';

// Tasks (Admin v2 C8, crm.md §9). `crm.tasks` is Admin's alone until C10b gives it to Sales
// (owner default O-7: Developer none), so every row allows Admin only. Developer and Sales
// hold leads.* and are refused here because neither holds crm.tasks.

const BASE = `/api/admin/crm/tasks/${UUID}`;

export const cases: readonly Case[] = [
  {
    name: 'tasks list (grouped)',
    load: () => import('@/pages/api/admin/crm/tasks/index'),
    method: 'GET',
    url: '/api/admin/crm/tasks?view=mine',
    allow: ['admin'],
    read: true,
  },
  {
    name: 'tasks of one lead',
    load: () => import('@/pages/api/admin/crm/tasks/index'),
    method: 'GET',
    url: `/api/admin/crm/tasks?lead=${UUID}`,
    allow: ['admin'],
    read: true,
  },
  {
    name: 'task added',
    load: () => import('@/pages/api/admin/crm/tasks/index'),
    method: 'POST',
    url: '/api/admin/crm/tasks',
    body: { title: 'Call back', type: 'call', dueDate: '2026-11-11', dueTime: '10:00' },
    allow: ['admin'],
  },
  {
    name: 'one task read again (the drawer after a 409)',
    load: () => import('@/pages/api/admin/crm/tasks/[id]'),
    method: 'GET',
    url: BASE,
    allow: ['admin'],
    read: true,
  },
  {
    name: 'task edit (versioned PATCH)',
    load: () => import('@/pages/api/admin/crm/tasks/[id]'),
    method: 'PATCH',
    url: BASE,
    body: { version: 1, title: 'Call back, again' },
    allow: ['admin'],
  },
  {
    name: 'task ticked done (unversioned PATCH)',
    load: () => import('@/pages/api/admin/crm/tasks/[id]'),
    method: 'PATCH',
    url: BASE,
    body: { done: true },
    allow: ['admin'],
  },
  {
    name: 'task snoozed to tomorrow 10:00',
    load: () => import('@/pages/api/admin/crm/tasks/[id]'),
    method: 'PATCH',
    url: BASE,
    body: { version: 1, snooze: 'tomorrow_10' },
    allow: ['admin'],
  },
  {
    name: 'task removed',
    load: () => import('@/pages/api/admin/crm/tasks/[id]'),
    method: 'DELETE',
    url: BASE,
    body: { version: 1 },
    allow: ['admin'],
  },
  {
    name: 'task calendar file (.ics)',
    load: () => import('@/pages/api/admin/crm/tasks/[id]/ics'),
    method: 'GET',
    url: `${BASE}/ics`,
    allow: ['admin'],
    read: true,
  },
];
