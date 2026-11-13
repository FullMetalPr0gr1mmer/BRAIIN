import type { NavArea } from './types';

// CRM: the leads the public forms bring in. Leads folds two views into one area (C4b,
// decision D2): the list and the pipeline board, as the page head's tabs. A lead's page
// (/admin/leads/<id>) lights the List tab, the longest tab it sits under. Contacts (C7): the
// people behind the leads, `crm.contacts` (Admin and, since C10b, Sales; Developer none,
// owner default O-7); a contact's page (/admin/contacts/<id>) lights it.
export const crm: NavArea = {
  title: 'CRM',
  order: 30,
  links: [
    {
      href: '/admin/leads',
      label: 'Leads',
      icon: 'inbox',
      caps: ['leads.manage'],
      count: 'leads',
      tabs: [
        { href: '/admin/leads', label: 'List', caps: ['leads.manage'] },
        { href: '/admin/leads/board', label: 'Pipeline', caps: ['leads.manage'] },
      ],
    },
    { href: '/admin/contacts', label: 'Contacts', icon: 'users', caps: ['crm.contacts'] },
    // Admin v2 C8: the follow-ups, with my overdue count (owner item O-9).
    {
      href: '/admin/tasks',
      label: 'Tasks',
      icon: 'check',
      caps: ['crm.tasks'],
      count: 'tasks',
      countWord: 'overdue',
    },
  ],
};
