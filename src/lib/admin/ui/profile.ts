import type { SingletonUi } from './types';

// The public identity, `site_profile`: the General screen's first form (/admin/settings,
// Admin v2 U9, the prototype's `route('/settings/general')`), drawn as its cards: Site, Brand
// and Advanced on the left, Contact and Social accounts on the right. The footer settings are
// stored on the same row but edited in Appearance › Footer (E6); the job-applications switch
// saves at once through its own endpoint (R3b), so neither is a field here.

const NETWORK_LABELS: readonly { value: string; label: string }[] = [
  { value: 'instagram', label: 'Instagram' },
  { value: 'linkedin', label: 'LinkedIn' },
  { value: 'behance', label: 'Behance' },
  { value: 'youtube', label: 'YouTube' },
  { value: 'x', label: 'X' },
  { value: 'tiktok', label: 'TikTok' },
  { value: 'snapchat', label: 'Snapchat' },
  { value: 'facebook', label: 'Facebook' },
];

/** Repeated on the brand name, the legal name and the email (the legal notices name them). */
const NOTICE_HINT =
  'Also named in the privacy notice, the terms and the job application notice. When you change it, tell the owner so those notices can be dated again.';

export const profileUi: SingletonUi = {
  endpoint: '/api/admin/site-profile',
  title: 'Public identity',
  fields: [
    {
      name: 'brandName',
      label: 'Site name',
      kind: 'bilingual',
      column: 'brand_name',
      required: true,
      help: `Shown in the header, the footer, page titles and search results. ${NOTICE_HINT}`,
    },
    {
      name: 'tagline',
      label: 'Tagline',
      kind: 'bilingual',
      nullable: true,
      maxLength: 120,
      help: 'A short line about the studio, used in search results. Both languages, or neither.',
    },
    {
      name: 'faviconMediaId',
      label: 'Favicon',
      kind: 'media',
      column: 'favicon_media_id',
      help: 'Square, at least 512 px. Shown in the browser tab.',
    },
    {
      name: 'appIconMediaId',
      label: 'App icon',
      kind: 'media',
      column: 'app_icon_media_id',
      help: 'For home screens. Square, at least 512 px.',
    },
    {
      name: 'contactEmail',
      label: 'Email',
      kind: 'text',
      column: 'contact_email',
      required: true,
      help: `Shown in the footer and on Contact, and the address for privacy requests, so it must be a monitored inbox. ${NOTICE_HINT}`,
    },
    {
      name: 'phoneE164',
      label: 'Phone',
      kind: 'text',
      column: 'phone_e164',
      help: 'With the country code, e.g. +9665XXXXXXXX.',
    },
    {
      name: 'phoneDisplay',
      label: 'Phone as displayed',
      kind: 'text',
      column: 'phone_display',
      maxLength: 32,
    },
    {
      name: 'whatsappE164',
      label: 'WhatsApp number',
      kind: 'text',
      column: 'whatsapp_e164',
      help: 'Shows on the Contact page. With the country code, e.g. +9665XXXXXXXX. Leave it empty and the WhatsApp card is not shown.',
    },
    {
      name: 'whatsappDisplay',
      label: 'WhatsApp number as displayed',
      kind: 'text',
      column: 'whatsapp_display',
      maxLength: 32,
    },
    {
      name: 'location',
      label: 'Address',
      kind: 'bilingual',
      required: true,
      help: 'Shown in the footer, e.g. Jeddah, Saudi Arabia.',
    },
    {
      name: 'mapUrl',
      label: 'Map link',
      kind: 'text',
      column: 'map_url',
      help: 'A Google Maps or Apple Maps link, e.g. https://maps.app.goo.gl/...',
    },
    {
      name: 'socials',
      label: 'Accounts',
      kind: 'repeater',
      maxItems: 8,
      help: 'Each link must point at its own network.',
      itemFields: [
        {
          name: 'network',
          label: 'Network',
          kind: 'select',
          options: NETWORK_LABELS,
          required: true,
        },
        { name: 'handle', label: 'Handle', kind: 'text', required: true, maxLength: 60 },
        { name: 'url', label: 'Link', kind: 'text', required: true },
        { name: 'visible', label: 'Show on the site', kind: 'checkbox', defaultValue: true },
      ],
    },
    {
      name: 'legalName',
      label: 'Registered legal name',
      kind: 'bilingual',
      column: 'legal_name',
      nullable: true,
      help: `The data controller in the privacy notice and the terms. Leave it empty to use the site name. ${NOTICE_HINT}`,
    },
    { name: 'foundedYear', label: 'Founded (year)', kind: 'number', column: 'founded_year' },
    {
      name: 'addressLocality',
      label: 'City (structured data)',
      kind: 'bilingual',
      column: 'address_locality',
      nullable: true,
    },
    {
      name: 'addressCountry',
      label: 'Country code',
      kind: 'text',
      column: 'address_country',
      help: 'Two capital letters, e.g. SA.',
    },
  ],
  groups: [
    { id: 'site', title: 'Site', column: 'left', fields: ['brandName', 'tagline'] },
    {
      id: 'brand',
      title: 'Brand',
      column: 'left',
      fields: ['faviconMediaId', 'appIconMediaId'],
    },
    {
      id: 'advanced',
      title: 'Advanced',
      column: 'left',
      collapsible: true,
      fields: ['legalName', 'foundedYear', 'addressLocality', 'addressCountry'],
    },
    {
      id: 'contact',
      title: 'Contact',
      column: 'right',
      fields: [
        'contactEmail',
        'phoneE164',
        'phoneDisplay',
        'whatsappE164',
        'whatsappDisplay',
        'location',
        'mapUrl',
      ],
    },
    {
      id: 'social',
      title: 'Social accounts',
      sub: 'Used in the Social section and in search results.',
      column: 'right',
      fields: ['socials'],
    },
  ],
};
