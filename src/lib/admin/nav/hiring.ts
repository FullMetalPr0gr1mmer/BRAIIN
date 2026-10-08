import type { NavArea } from './types';

// Hiring: the Join form's applications.
export const hiring: NavArea = {
  title: 'Hiring',
  order: 40,
  links: [
    // Join (careers): Admin only — owner decision J6. Never part of the CRM.
    {
      href: '/admin/applications',
      label: 'Job applications',
      icon: 'hand',
      caps: ['applications.manage'],
      count: 'applications',
    },
  ],
};
