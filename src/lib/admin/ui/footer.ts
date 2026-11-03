import { FOOTER_COPYRIGHT_MAX } from '@schemas/siteProfile';
import type { SingletonUi } from './types';

// The footer's basics (Admin v2 E6, /admin/appearance/footer, the prototype's
// `route('/appearance/footer')` Basics card): four columns of the public identity row,
// `site_profile` (U9, 0102; P-9: footer settings live on that row under settings.general), so
// they are saved through the identity's own endpoint and keep its history. The General
// screen's form (./profile.ts) leaves them out; this form names only them, so a save here
// writes nothing else of the row. The columns, the legal links and the sketch are the Footer
// screen's own (src/components/admin/screens/footer/).
//
// Copy rules (P-12): plain, warm, no em or en dash, the brand never spelled.

export const footerUi: SingletonUi = {
  endpoint: '/api/admin/site-profile',
  title: 'Footer',
  fields: [
    {
      name: 'footerCopyright',
      label: 'Copyright line',
      kind: 'bilingual',
      nullable: true,
      help: `Up to ${FOOTER_COPYRIGHT_MAX} characters in each language. {year} becomes this year, {brand} the site name and {place} the location, both from General. Leave both empty for the built-in line: © {year} {brand}. {place}`,
    },
    {
      name: 'footerStyle',
      label: 'Footer style',
      kind: 'select',
      required: true,
      options: [
        { value: 'light', label: 'Light' },
        { value: 'dark', label: 'Dark' },
      ],
      help: 'Light is white with dark words; Dark is black with light words. Both keep every word easy to read.',
    },
    {
      name: 'footerShowEmail',
      label: 'Show the email address',
      kind: 'checkbox',
      help: 'The studio mailbox from General.',
    },
    {
      name: 'footerShowSocial',
      label: 'Show social icons',
      kind: 'checkbox',
      help: 'The accounts set to Show on the site. They are managed in Settings, General.',
    },
  ],
  // The prototype's two columns: Basics on the left, the sketch on the right (the screen's
  // own slot, drawn from the form as it is).
  groups: [
    {
      id: 'basics',
      title: 'Basics',
      column: 'left',
      fields: ['footerCopyright', 'footerStyle', 'footerShowEmail', 'footerShowSocial'],
    },
    { id: 'preview', title: 'Preview', column: 'right', fields: [] },
  ],
};
