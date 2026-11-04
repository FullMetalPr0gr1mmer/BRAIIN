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
    // Admin v2 E5: the header's options (theme.edit) and its menu links (nav.edit), each card
    // for its own capability.
    {
      href: '/admin/appearance/header',
      label: 'Header',
      icon: 'header',
      caps: ['theme.edit', 'nav.edit'],
    },
    // Admin v2 E6: the footer's basics (settings.general) and its link columns (nav.edit),
    // each card for its own capability.
    {
      href: '/admin/appearance/footer',
      label: 'Footer',
      icon: 'link',
      caps: ['settings.general', 'nav.edit'],
    },
    // Admin v2 E7: the loading screen's look (theme.edit) and its on/off switch on the home
    // hero (pages.write), each card for its own capability.
    {
      href: '/admin/appearance/loading',
      label: 'Loading screen',
      icon: 'loader',
      caps: ['theme.edit', 'pages.write'],
    },
    { href: '/admin/navigation', label: 'Menus', icon: 'list', caps: ['nav.edit'] },
  ],
};
