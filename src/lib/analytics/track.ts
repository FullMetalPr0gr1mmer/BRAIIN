import type { CtaId } from '@schemas/analytics';

// Which `data-track` id a public link carries (Admin v2 G1, the click vocabulary CTA_IDS in
// packages/schemas/analytics.ts). Most anchors name theirs in the markup; the links whose
// target is authored (the header and footer menus, the lead band's button) are counted when
// they lead to the contact page, in either language, with or without its form's fragment.

const CONTACT = /^(?:\/ar)?\/contact\/?(?:#.*)?$/;

/** `contact_link` for a link to the contact page, else nothing (no attribute renders). */
export function trackHref(href: string | null | undefined): CtaId | undefined {
  return typeof href === 'string' && CONTACT.test(href) ? 'contact_link' : undefined;
}
