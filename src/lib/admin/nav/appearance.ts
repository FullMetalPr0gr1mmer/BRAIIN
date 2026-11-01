import type { NavArea } from './types';

// Appearance: the theme and the site's menus.
export const appearance: NavArea = {
  title: 'Appearance',
  order: 60,
  links: [
    // Admin v2 E4: the theme editor; the retired /admin/themes/** answer there with a 302.
    {
      href: '/admin/appearance/theme',
      label: 'Theme',
      icon: 'palette',
      caps: ['theme.edit'],
      match: ['/admin/themes'],
    },
    { href: '/admin/navigation', label: 'Menus', icon: 'header', caps: ['nav.edit'] },
  ],
};
