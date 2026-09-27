import type { SectionData } from './types';

// The contact page's Cache-Tag entities (UI v2 PR9): what its bands read, so a publish of
// any of it purges /contact and /ar/contact — the page composition and the services list
// (the form's "What do you need?" options). The channels and socials are the public
// identity, which every Tier-A page already carries (`site:identity`).
export const CONTACT_CACHE_ENTITIES = ['page:contact', 'services:all'] as const;

/**
 * The contact route's own data, handed to the inquiry band as `data` (never CMS content):
 * the published services, which become the form's options.
 */
export function withContactData<Service>(
  sections: readonly SectionData[],
  data: { services: readonly Service[] },
): SectionData[] {
  return sections.map((s) =>
    s.type === 'contactInquiry' ? { ...s, data: { ...s.data, services: data.services } } : s,
  );
}

/**
 * Whether the page will render the FAQ band. The FAQPage JSON-LD is emitted only then: an
 * editor who hides or removes the FAQ must take its structured data with it, or the head
 * describes questions the page does not visibly contain (a manual-action category).
 */
export function faqShown(sections: readonly SectionData[]): boolean {
  return sections.some((s) => s.type === 'faq' && s.visible !== false);
}
