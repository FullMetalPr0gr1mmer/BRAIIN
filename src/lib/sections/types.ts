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

/**
 * The home page (UI v2 PR7), in the design's order. The data-driven bands (clients,
 * selected work, numbers, testimonials) render nothing when their table is empty — in
 * production the design's sample projects and quotes start as drafts — so this list
 * never shows an empty shell. Mirrored by the seeded composition
 * (supabase/seed-data/50-home.json; tests/lib/sections.spec.ts holds the two together).
 */
export const DEFAULT_HOME_SECTIONS: SectionData[] = [
  { type: 'hero' },
  { type: 'clientsMarquee' },
  { type: 'selectedWork' },
  { type: 'statistics', props: { variant: 'band', placement: 'home' } },
  { type: 'testimonials', props: { variant: 'klein', placement: 'home' } },
  { type: 'servicesOverview' },
  { type: 'aboutIntro' },
  { type: 'slogan' },
  { type: 'contact' },
  { type: 'social' },
];

/** The in-page anchor of the home Selected work band (SelectedWork.astro renders it). */
export const SELECTED_WORK_ANCHOR = '#selected-work';

/**
 * Where the home hero's "See our work" points. The design sends it to the Selected work
 * band — but that band hides when no project is featured (production starts with the
 * sample projects as drafts) or when an editor hides or removes it, and an anchor to a
 * section that is not there is a dead button. Then it goes to Our Work instead.
 */
export function homeHeroCtaHref(
  sections: readonly SectionData[],
  featuredCount: number,
): typeof SELECTED_WORK_ANCHOR | '/portfolio' {
  const bandShown = sections.some((s) => s.type === 'selectedWork' && s.visible !== false);
  return bandShown && featuredCount > 0 ? SELECTED_WORK_ANCHOR : '/portfolio';
}

/**
 * The home route's own data, handed to the sections as `data` (never CMS content): the
 * featured project cards (loaded once, for the band and for the CTA decision above) go to
 * every Selected work band, and the CTA target to the first hero.
 */
export function withHomeData<Card>(
  sections: readonly SectionData[],
  data: { featured: readonly Card[]; ctaHref: string },
): SectionData[] {
  let heroSeen = false;
  return sections.map((s) => {
    if (s.type === 'selectedWork') return { ...s, data: { ...s.data, cards: data.featured } };
    if (s.type === 'hero' && !heroSeen) {
      heroSeen = true;
      return { ...s, data: { ...s.data, ctaHref: data.ctaHref } };
    }
    return s;
  });
}

/** The in-page anchor of Our Work's featured grid (ProjectGrid.astro renders it). */
export const PROJECTS_ANCHOR = '#projects';

/**
 * Where Our Work's intro link ("See the projects") points — the home hero CTA's rule. The
 * design sends it to the featured grid below, which renders only when a published project
 * is featured and the grid section is shown; otherwise it goes to All projects, and with
 * nothing published at all (production before its content is approved) there is nowhere
 * worth sending anyone: null, and the link is left out.
 */
export function workIntroLinkHref(
  sections: readonly SectionData[],
  featuredCount: number,
  publishedCount: number,
): typeof PROJECTS_ANCHOR | '/portfolio/all' | null {
  const gridShown = sections.some((s) => s.type === 'projectGrid' && s.visible !== false);
  if (gridShown && featuredCount > 0) return PROJECTS_ANCHOR;
  return publishedCount > 0 ? '/portfolio/all' : null;
}

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

// UI v2 (PR8) — the mockup's About: who we are → leadership → our reach → follow. The
// pre-v2 story / team grid / certifications / CTA band stay available as section types;
// the design drops them from this page. Code defaults carry no media (text-only "who"):
// the poster and clip are seeded content (supabase/seed-data/51-about.json).
export const DEFAULT_ABOUT_SECTIONS: SectionData[] = [
  { type: 'aboutWho' },
  { type: 'leadership' },
  { type: 'statistics', props: { variant: 'reach', placement: 'about' } },
  { type: 'social', props: { variant: 'klein' } },
];

/**
 * Our Work (`/portfolio`, UI v2 PR10), before it is composed in the CMS. Every section
 * hides on its own when its table is empty (no featured project → no grid, no quotes →
 * numbers alone), so this renders cleanly on a fresh production database too.
 */
export const DEFAULT_WORK_SECTIONS: SectionData[] = [
  { type: 'workHero' },
  { type: 'proof' },
  { type: 'workIntro' },
  { type: 'projectGrid' },
  { type: 'clientsMarquee' },
  { type: 'cta' },
];

/** All projects (`/portfolio/all`, UI v2 PR10). */
export const DEFAULT_CATALOG_SECTIONS: SectionData[] = [
  { type: 'pageHead' },
  { type: 'projectCatalog' },
  { type: 'cta' },
];
