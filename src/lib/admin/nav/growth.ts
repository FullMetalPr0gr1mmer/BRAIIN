import type { NavArea } from './types';

// Growth: website stats, site health and the Style-Finder.
export const growth: NavArea = {
  title: 'Growth',
  order: 50,
  links: [
    {
      href: '/admin/analytics',
      label: 'Website stats',
      icon: 'chart',
      caps: ['analytics.read'],
      match: ['/admin/analytics/search'],
      tabs: [
        { href: '/admin/analytics', label: 'Overview', caps: ['analytics.read'] },
        { href: '/admin/analytics/search', label: 'Search', caps: ['analytics.search'] },
      ],
    },
    {
      // Its views (Overview, Speed, Errors, SEO) are in-page tabs (Admin v2 U2); the old
      // /admin/logs redirects to the Errors tab and still lights this link.
      href: '/admin/site-health',
      label: 'Site health',
      icon: 'shield',
      caps: ['siteHealth.view'],
      match: ['/admin/logs'],
    },
    {
      href: '/admin/ai-questions',
      label: 'Style-Finder',
      icon: 'sparkle',
      caps: ['ai.editContent'],
      match: ['/admin/ai-styles', '/admin/ai-config'],
      tabs: [
        { href: '/admin/ai-questions', label: 'Questions', caps: ['ai.editContent'] },
        { href: '/admin/ai-styles', label: 'Styles', caps: ['ai.editContent'] },
        { href: '/admin/ai-config', label: 'Results & logic', caps: ['ai.config'] },
      ],
    },
  ],
};
