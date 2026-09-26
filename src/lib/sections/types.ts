// CMS section engine types. A page is an ordered list of typed, toggleable sections.
// In Phase 3 these come from the `page_sections` table; until then pages use the
// default compositions below so the site looks real before content is authored.

export interface SectionData {
  type: string;
  visible?: boolean;
  /** Per-instance overrides; section components also localise their own copy. */
  props?: Record<string, unknown>;
  /**
   * Data the ROUTE injects (rows it already loaded — a case study, the facet selection).
   * Rendered as the component's `data` prop AFTER the content props, so authored CMS
   * content can never replace it.
   */
  data?: Record<string, unknown>;
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

export const DEFAULT_CONTACT_SECTIONS: SectionData[] = [
  { type: 'hero', props: { banner: true, ctaHref: '#inquiry' } },
  { type: 'contactInquiry' },
  { type: 'contactChannels' },
  { type: 'faq' },
];

/**
 * The inquiry form is the site's ONLY public write path, and SectionRenderer honours
 * `visible: false` unconditionally — so an editor toggling this section off would take
 * the contact form off the contact page with nothing to stop them and no gate to catch
 * it. This re-inserts it, visible, whatever the authored composition says.
 *
 * Deliberately narrower than `withHomeIntro`: that one supplies a default an editor may
 * override, this one enforces a floor an editor may not. Reordering it is still free.
 */
export function ensureContactInquiry(sections: SectionData[]): SectionData[] {
  const restored = sections.map((s) => (s.type === 'contactInquiry' ? { ...s, visible: true } : s));
  if (restored.some((s) => s.type === 'contactInquiry')) return restored;
  // Absent entirely: put it back directly after the hero, where the design expects it.
  const heroAt = restored.findIndex((s) => s.type === 'hero');
  const at = heroAt === -1 ? 0 : heroAt + 1;
  return [...restored.slice(0, at), { type: 'contactInquiry' }, ...restored.slice(at)];
}

export const DEFAULT_ABOUT_SECTIONS: SectionData[] = [
  { type: 'aboutStory' },
  { type: 'statistics' },
  { type: 'team' },
  { type: 'certifications' },
  { type: 'cta' },
];
