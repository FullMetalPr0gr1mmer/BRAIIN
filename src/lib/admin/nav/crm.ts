import type { NavArea } from './types';

// CRM: the leads the public forms bring in.
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
    },
  ],
};
