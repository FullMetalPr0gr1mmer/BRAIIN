import type { SingletonUi } from './types';

// The header's options, `site_appearance` (Admin v2 E5, /admin/appearance/header, the
// prototype's `route('/appearance/header')`): the Layout, Behaviour and Button cards, every
// option a closed set (packages/schemas/appearance.ts) so the site stays inside what its CSS
// and its budgets were built for. The Menu items card is the navigation's, not this row's
// (nav.edit, P-9), and the preview and the facts are the screen's own
// (src/components/admin/screens/header/).
//
// Copy rules (P-12): plain, warm, no em or en dash, the brand never spelled.

export const appearanceUi: SingletonUi = {
  endpoint: '/api/admin/site-appearance',
  title: 'Header',
  fields: [
    {
      name: 'logoPosition',
      label: 'Logo position',
      kind: 'select',
      column: 'header_logo_position',
      required: true,
      options: [
        { value: 'start', label: 'At the start' },
        { value: 'center', label: 'In the centre' },
      ],
      help: 'On wide screens. Phones always show the logo at the start.',
    },
    {
      name: 'logoSize',
      label: 'Logo size',
      kind: 'select',
      column: 'header_logo_size',
      required: true,
      options: [
        { value: 's', label: 'Small' },
        { value: 'm', label: 'Medium' },
        { value: 'l', label: 'Large' },
      ],
      help: 'The bar grows with the logo, and the page below moves with it.',
    },
    {
      name: 'menuAlign',
      label: 'Menu alignment',
      kind: 'select',
      column: 'header_menu_align',
      required: true,
      options: [
        { value: 'start', label: 'Next to the logo' },
        { value: 'center', label: 'In the middle' },
        { value: 'end', label: 'Next to the language switch' },
      ],
      help: 'On wide screens, with the logo at the start.',
    },
    {
      name: 'sticky',
      label: 'Sticky (stays at the top)',
      kind: 'checkbox',
      column: 'header_sticky',
      help: 'Off: the bar scrolls away with the page.',
    },
    {
      name: 'hideOnScroll',
      label: 'Hide when scrolling down',
      kind: 'checkbox',
      column: 'header_hide_on_scroll',
      help: 'Shows again on the first scroll up.',
    },
    {
      name: 'solidAfterHero',
      label: 'Turn solid after the hero',
      kind: 'checkbox',
      column: 'header_solid_after_hero',
      help: 'Off: the bar keeps its tint over the rest of the page, so it needs the darkest tint.',
    },
    {
      name: 'tint',
      label: 'Tint over the hero',
      kind: 'select',
      column: 'header_tint',
      required: true,
      options: [
        { value: 'none', label: 'None (see-through)' },
        { value: 'light', label: 'Light' },
        { value: 'medium', label: 'Medium' },
        { value: 'dark', label: 'Dark' },
      ],
    },
    {
      name: 'blur',
      label: 'Blur behind the bar',
      kind: 'select',
      column: 'header_blur',
      required: true,
      options: [
        { value: 'none', label: 'None' },
        { value: 'soft', label: 'Soft' },
        { value: 'strong', label: 'Strong' },
      ],
      help: 'Once the bar turns solid.',
    },
    {
      name: 'mobileMenu',
      label: 'Menu on phones',
      kind: 'select',
      column: 'header_mobile_menu',
      required: true,
      options: [
        { value: 'drawer', label: 'A panel under the bar' },
        { value: 'full', label: 'Full screen' },
      ],
    },
    {
      name: 'ctaShow',
      label: 'Show a button',
      kind: 'checkbox',
      column: 'header_cta_show',
      help: 'A filled button at the end of the bar, and at the end of the menu on phones.',
    },
    {
      name: 'ctaLabel',
      label: 'Button words',
      kind: 'bilingual',
      column: 'header_cta_label',
      nullable: true,
      maxLength: 40,
    },
    {
      name: 'ctaHref',
      label: 'Button link',
      kind: 'text',
      column: 'header_cta_href',
      maxLength: 300,
      help: 'A page of this site, starting with / (for example /contact#inquiry), or a link starting with https://',
    },
  ],
  groups: [
    {
      id: 'layout',
      title: 'Layout',
      column: 'left',
      fields: ['logoPosition', 'logoSize', 'menuAlign'],
    },
    {
      id: 'behaviour',
      title: 'Behaviour',
      column: 'left',
      fields: ['sticky', 'hideOnScroll', 'solidAfterHero', 'tint', 'blur', 'mobileMenu'],
    },
    {
      id: 'button',
      title: 'Button',
      sub: 'Optional',
      column: 'left',
      fields: ['ctaShow', 'ctaLabel', 'ctaHref'],
    },
    { id: 'preview', title: 'Preview', column: 'right', fields: [] },
    { id: 'facts', title: 'Always true', column: 'right', fields: [] },
  ],
};
