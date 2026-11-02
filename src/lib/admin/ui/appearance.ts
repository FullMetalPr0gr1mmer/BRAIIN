import { HEADER_COLUMNS } from '@schemas/appearance';
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
      column: HEADER_COLUMNS.logoPosition,
      required: true,
      options: [
        { value: 'start', label: 'At the start' },
        { value: 'center', label: 'In the centre' },
      ],
      help: 'Centred from 1280 pixels wide, where the menu fits beside it. Narrower screens and phones show the logo at the start.',
    },
    {
      name: 'logoSize',
      label: 'Logo size',
      kind: 'select',
      column: HEADER_COLUMNS.logoSize,
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
      column: HEADER_COLUMNS.menuAlign,
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
      column: HEADER_COLUMNS.sticky,
      help: 'Off: the bar scrolls away with the page.',
    },
    {
      name: 'hideOnScroll',
      label: 'Hide when scrolling down',
      kind: 'checkbox',
      column: HEADER_COLUMNS.hideOnScroll,
      help: 'Shows again on the first scroll up.',
    },
    {
      name: 'solidAfterHero',
      label: 'Turn solid after the hero',
      kind: 'checkbox',
      column: HEADER_COLUMNS.solidAfterHero,
      help: 'Off: the bar keeps its tint over the rest of the page, so it needs the darkest tint.',
    },
    {
      name: 'tint',
      label: 'Tint over the hero',
      kind: 'select',
      column: HEADER_COLUMNS.tint,
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
      column: HEADER_COLUMNS.blur,
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
      column: HEADER_COLUMNS.mobileMenu,
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
      column: HEADER_COLUMNS.ctaShow,
      help: 'A filled button at the end of the bar, and at the end of the menu on phones.',
    },
    {
      name: 'ctaLabel',
      label: 'Button words',
      kind: 'bilingual',
      column: HEADER_COLUMNS.ctaLabel,
      nullable: true,
      maxLength: 40,
      help: 'Two or three words keep the bar on one line beside the menu.',
    },
    {
      name: 'ctaHref',
      label: 'Button link',
      kind: 'text',
      column: HEADER_COLUMNS.ctaHref,
      maxLength: 300,
      help: 'A page of this site, starting with / (for example /contact#inquiry; leave out /ar, Arabic pages add it), or a link starting with https://',
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
