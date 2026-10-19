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
      match: ['/admin/maintenance', '/admin/visibility'],
      tabs: [
        { href: '/admin/settings', label: 'General', caps: ['settings.general'] },
        { href: '/admin/maintenance', label: 'Maintenance', caps: ['maintenance.manage'] },
        // Admin v2 U14a: who can see each page.
        { href: '/admin/visibility', label: 'Page visibility', caps: ['maintenance.manage'] },
      ],
    },
    {
      href: '/admin/seo',
      label: 'SEO',
      icon: 'seo',
      caps: ['seo.globalDefaults', 'redirects.manage'],
      // Admin v2 U10: Pages, Redirects and Site wide are in-page tabs of /admin/seo (`?tab=`,
      // as Site health), so the area has no tabs of its own; the no-JS redirect pages still
      // light the link.
      match: ['/admin/redirects'],
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
