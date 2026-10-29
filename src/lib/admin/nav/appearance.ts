import type { NavArea } from './types';

// Appearance: the theme and the site's menus.
export const appearance: NavArea = {
  title: 'Appearance',
  order: 60,
  links: [
    { href: '/admin/themes', label: 'Theme', icon: 'palette', caps: ['theme.edit'] },
    // Admin v2 E5: the header's options (theme.edit) and its menu links (nav.edit), each card
    // for its own capability.
    {
      href: '/admin/appearance/header',
      label: 'Header',
      icon: 'header',
      caps: ['theme.edit', 'nav.edit'],
    },
    { href: '/admin/navigation', label: 'Menus', icon: 'list', caps: ['nav.edit'] },
  ],
};
