import type { NavArea } from './types';

// Appearance: the theme and the site's menus.
export const appearance: NavArea = {
  title: 'Appearance',
  order: 60,
  links: [
    { href: '/admin/themes', label: 'Theme', icon: 'palette', caps: ['theme.edit'] },
    { href: '/admin/navigation', label: 'Menus', icon: 'header', caps: ['nav.edit'] },
  ],
};
