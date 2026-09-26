import type { Locale } from '@schemas/primitives';
import type { Leader } from '@/lib/data/team';
import { pickLocale } from '@/lib/i18n';
import { buildPersonSchema, type JsonLdNode, type OrgRef } from '@/lib/seo/jsonld';
import type { SectionData } from './types';

// Route plumbing for /about and /ar/about (UI v2 PR8), kept out of the two .astro routes
// so it is written once and unit-tested.

/** Whether the page renders a section of this type (SectionRenderer skips hidden ones). */
export function showsSection(sections: readonly SectionData[], type: string): boolean {
  return sections.some((s) => s.type === type && s.visible !== false);
}

/**
 * Hands the leadership rows the route already loaded to every leadership section, as
 * route `data` (rendered after the CMS content, so no authored key can replace them).
 */
export function withLeaders(sections: readonly SectionData[], leaders: Leader[]): SectionData[] {
  return sections.map((s) =>
    s.type === 'leadership' ? { ...s, data: { ...(s.data ?? {}), leaders } } : s,
  );
}

/**
 * Person JSON-LD for the leaders the page actually shows — none when the leadership
 * section is hidden or absent, so the structured data never names people a visitor cannot
 * see. Role → jobTitle, LinkedIn → sameAs, portrait → image (absolute).
 */
export function leadershipJsonLd(
  sections: readonly SectionData[],
  leaders: readonly Leader[],
  opts: { locale: Locale; org: OrgRef; siteBase: string },
): JsonLdNode[] {
  if (!showsSection(sections, 'leadership')) return [];
  return leaders.map((l) => {
    const jobTitle = l.role ? pickLocale(l.role, opts.locale) : '';
    return buildPersonSchema({
      name: pickLocale(l.name, opts.locale, l.slug),
      org: opts.org,
      ...(jobTitle ? { jobTitle } : {}),
      ...(l.linkedinUrl ? { sameAs: [l.linkedinUrl] } : {}),
      ...(l.portrait ? { image: opts.siteBase + l.portrait.src.src } : {}),
    });
  });
}
