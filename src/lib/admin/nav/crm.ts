import type { NavArea } from './types';

// CRM: the leads the public forms bring in. Leads folds two views into one area (C4b,
// decision D2): the list and the pipeline board, as the page head's tabs. A lead's page
// (/admin/leads/<id>) lights the List tab, the longest tab it sits under.
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
  ],
};
