import { RELEASE_READ_CAPS } from '@/lib/release/readCaps';
import type { NavArea } from './types';

// Settings: the site's identity, SEO, integrations, people, the activity log and the CRM's
// configuration.
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
    // Admin v2 U11: the two forms' fields and protections, read-only (General's capability:
    // the forms config is `settings.general`, P-2); and the bell's settings, every member's
    // own (`analytics.read`, which every role holds). The longer route wins, so
    // /admin/settings/notifications lights Notifications, not General.
    { href: '/admin/forms', label: 'Forms', icon: 'form', caps: ['settings.general'] },
    {
      href: '/admin/settings/notifications',
      label: 'Notifications',
      icon: 'bell',
      caps: ['analytics.read'],
    },
    {
      href: '/admin/integrations',
      label: 'Integrations',
      icon: 'plug',
      caps: ['settings.integrations'],
    },
    { href: '/admin/users', label: 'Users & roles', icon: 'key', caps: ['users.manage'] },
    { href: '/admin/audit', label: 'Activity log', icon: 'history', caps: ['audit.view'] },
    // Admin v2 R13 (plan B7.3): the site's versions and the content backup, for the CMS roles
    // holding a release read capability (the pending summary's gate, PENDING_ANY_CAP: every
    // role but Sales), at full, view or meta.
    {
      href: '/admin/backups',
      label: 'Backups & versions',
      icon: 'db',
      caps: [...RELEASE_READ_CAPS],
    },
    // Admin v2 C9a: the pipeline stages, scoring, response time and assignment (Admin only).
    {
      href: '/admin/crm/settings',
      label: 'CRM settings',
      icon: 'kanban',
      caps: ['crm.settings'],
    },
  ],
};
