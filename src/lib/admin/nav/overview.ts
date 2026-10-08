import type { NavArea } from './types';

// Overview: the dashboard.
export const overview: NavArea = {
  title: 'Overview',
  order: 10,
  links: [{ href: '/admin', label: 'Dashboard', icon: 'home', caps: ['analytics.read'] }],
};
