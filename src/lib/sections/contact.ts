import type { FaqEntry } from '@schemas/faq';
import type { SectionData } from './types';

// The contact page's Cache-Tag entities (UI v2 PR9): what its bands read, so a publish of
// any of it purges /contact and /ar/contact — the page composition, the disciplines and
// services behind the form's grouped "What do you need?" select (Round 2), and the FAQ
// (Admin v2 U7: public.faq_items, its band and its FAQPage JSON-LD). The channels and
// socials are the public identity, which every Tier-A page already carries (`site:identity`).
export const CONTACT_CACHE_ENTITIES = [
  'page:contact',
  'services:all',
  'disciplines:all',
  'faq:all',
] as const;

/**
 * The contact route's own data, handed to the sections as `data` (never CMS content): the
 * published disciplines with their services, which become the inquiry form's grouped
 * options, and the published FAQ, which the FAQ band renders (the same array the route
 * builds the FAQPage JSON-LD from: one read, two outputs that cannot disagree).
 */
export function withContactData<Group>(
  sections: readonly SectionData[],
  data: { groups: readonly Group[]; faq: readonly FaqEntry[] },
): SectionData[] {
  return sections.map((s) => {
    if (s.type === 'contactInquiry') return { ...s, data: { ...s.data, groups: data.groups } };
    if (s.type === 'faq') return { ...s, data: { ...s.data, items: data.faq } };
    return s;
  });
}

/**
 * Whether the page will render the FAQ band: a visible FAQ section AND at least one
 * published question (the band renders nothing without one). The FAQPage JSON-LD is
 * emitted only then: an editor who hides or removes the FAQ, or unpublishes every
 * question, takes its structured data with it, or the head describes questions the page
 * does not visibly contain (a manual-action category).
 */
export function faqShown(sections: readonly SectionData[], items: readonly FaqEntry[]): boolean {
  return items.length > 0 && sections.some((s) => s.type === 'faq' && s.visible !== false);
}
