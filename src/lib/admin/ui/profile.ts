import type { SingletonUi } from './types';

// Public identity: one row per tenant, the form at /admin/settings.
export const profileUi: SingletonUi = {
  endpoint: '/api/admin/site-profile',
  title: 'Public identity',
  fields: [
    {
      name: 'brandName',
      label: 'Brand name',
      kind: 'bilingual',
      column: 'brand_name',
      required: true,
      help: 'Shown in the header, footer, page titles and Organization JSON-LD on every page — and named in the Privacy Policy, Terms, Cookie Policy and the job-application consent. Changing it changes those notices: tell the owner, so their dates and the recruitment notice version are updated with it.',
    },
    {
      name: 'legalName',
      label: 'Registered legal name',
      kind: 'bilingual',
      column: 'legal_name',
      nullable: true,
      help: 'The data controller named in the Privacy Policy and Terms (and so in the recruitment notice). Leave empty to use the brand name. Changing it changes those notices: tell the owner, so their dates and the recruitment notice version are updated with it.',
    },
    {
      name: 'contactEmail',
      label: 'Contact email',
      kind: 'text',
      column: 'contact_email',
      required: true,
      help: 'Shown in the footer and on Contact — and the address the Privacy Policy gives for privacy requests and applicants’ rights, so it must be a monitored inbox. Changing it changes the Privacy Policy: tell the owner, so its date and the recruitment notice version are updated with it.',
    },
    {
      name: 'whatsappE164',
      label: 'WhatsApp number (E.164)',
      kind: 'text',
      column: 'whatsapp_e164',
      help: 'e.g. +9665XXXXXXXX. Leave empty and the WhatsApp contact card is not shown.',
    },
    {
      name: 'whatsappDisplay',
      label: 'WhatsApp number as displayed',
      kind: 'text',
      column: 'whatsapp_display',
    },
    {
      name: 'location',
      label: 'Location',
      kind: 'bilingual',
      required: true,
      help: 'Footer copy, e.g. “Jeddah, Saudi Arabia”.',
    },
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
      help: 'ISO 3166-1 alpha-2, e.g. SA.',
    },
    { name: 'foundedYear', label: 'Founded (year)', kind: 'number', column: 'founded_year' },
    {
      name: 'socials',
      label: 'Social links (JSON)',
      kind: 'json',
      help: '[{"network":"instagram","handle":"@…","url":"https://instagram.com/…"}] — each link must point at its own network.',
    },
    {
      name: 'acceptingApplications',
      label: 'Accepting job applications',
      kind: 'checkbox',
      column: 'accepting_applications',
      help: 'Admin only — opens the public application form on /join.',
    },
  ],
};
