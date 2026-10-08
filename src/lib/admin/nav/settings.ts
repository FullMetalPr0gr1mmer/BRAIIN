import type { NavArea } from './types';

// Settings: the site's identity, SEO, integrations, people and the activity log.
export const settings: NavArea = {
  title: 'Settings',
  order: 70,
  links: [
    {
      href: '/admin/settings',
      label: 'General',
      icon: 'settings',
      caps: ['settings.general'],
      match: ['/admin/maintenance'],
      tabs: [
        { href: '/admin/settings', label: 'General', caps: ['settings.general'] },
        { href: '/admin/maintenance', label: 'Maintenance', caps: ['maintenance.manage'] },
      ],
    },
    {
      href: '/admin/seo',
      label: 'SEO',
      icon: 'seo',
      caps: ['seo.globalDefaults', 'redirects.manage'],
      match: ['/admin/redirects'],
      tabs: [
        { href: '/admin/seo', label: 'Defaults', caps: ['seo.globalDefaults'] },
        { href: '/admin/redirects', label: 'Redirects', caps: ['redirects.manage'] },
      ],
    },
    {
      href: '/admin/integrations',
      label: 'Integrations',
      icon: 'plug',
      caps: ['settings.integrations'],
    },
    { href: '/admin/users', label: 'Users & roles', icon: 'key', caps: ['users.manage'] },
    { href: '/admin/audit', label: 'Activity log', icon: 'history', caps: ['audit.view'] },
  ],
};
