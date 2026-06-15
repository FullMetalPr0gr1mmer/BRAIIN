// CMS section engine types. A page is an ordered list of typed, toggleable sections.
// In Phase 3 these come from the `page_sections` table; until then pages use the
// default compositions below so the site looks real before content is authored.

export interface SectionData {
  type: string;
  visible?: boolean;
  /** Per-instance overrides; section components also localise their own copy. */
  props?: Record<string, unknown>;
}

export const DEFAULT_HOME_SECTIONS: SectionData[] = [
  { type: 'hero' },
  { type: 'servicesOverview' },
  { type: 'cta' },
  { type: 'social' },
];

export const DEFAULT_ABOUT_SECTIONS: SectionData[] = [
  { type: 'aboutStory' },
  { type: 'statistics' },
  { type: 'team' },
  { type: 'certifications' },
  { type: 'cta' },
];
