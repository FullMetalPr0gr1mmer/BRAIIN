// CMS section engine types. A page is an ordered list of typed, toggleable sections.
// In Phase 3 these come from the `page_sections` table; until then pages use the
// default compositions below so the site looks real before content is authored.

export interface SectionData {
  type: string;
  visible?: boolean;
  /** Per-instance overrides; section components also localise their own copy. */
  props?: Record<string, unknown>;
}

/**
 * Marks the first `hero` as the one that opens with the brand intro plate.
 *
 * This is applied at the ROUTE level (the home page calls it) rather than baked into a
 * section's CMS content, for two reasons: authoring a home page in the CMS cannot
 * silently drop the intro — the plate is a property of "this is the home page", not of
 * a row someone edited — and a `hero` section placed on any other page never gains an
 * undismissable full-viewport overlay. Hero.astro defaults `intro` to false, so off is
 * the safe default everywhere else.
 *
 * An explicit `intro` in the CMS content still wins: that is the off switch.
 */
export function withHomeIntro(sections: SectionData[]): SectionData[] {
  let applied = false;
  return sections.map((s) => {
    if (applied || s.type !== 'hero') return s;
    applied = true;
    return { ...s, props: { intro: true, ...(s.props ?? {}) } };
  });
}

export const DEFAULT_HOME_SECTIONS: SectionData[] = [
  { type: 'hero' },
  { type: 'aboutIntro' },
  { type: 'slogan' },
  { type: 'clientsMarquee' },
  { type: 'servicesOverview' },
  { type: 'contact' },
  { type: 'social' },
];

export const DEFAULT_ABOUT_SECTIONS: SectionData[] = [
  { type: 'aboutStory' },
  { type: 'statistics' },
  { type: 'team' },
  { type: 'certifications' },
  { type: 'cta' },
];
