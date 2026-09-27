// CMS section engine types. A page is an ordered list of typed, toggleable sections.
// In Phase 3 these come from the `page_sections` table; until then pages use the
// default compositions below so the site looks real before content is authored.

import type { HeroText } from '@/lib/text/heroLinks';

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
 * every Selected work band, and the CTA target to the first hero. Round 2: the published
 * disciplines (loaded once) go to the discipline cards — in home mode — and to the home
 * lead form's grouped select.
 */
export function withHomeData<Card, Discipline>(
  sections: readonly SectionData[],
  data: { featured: readonly Card[]; ctaHref: string; disciplines: readonly Discipline[] },
): SectionData[] {
  let heroSeen = false;
  return sections.map((s) => {
    if (s.type === 'selectedWork') return { ...s, data: { ...s.data, cards: data.featured } };
    if (s.type === 'servicesOverview') {
      return { ...s, data: { ...s.data, mode: 'home', disciplines: data.disciplines } };
    }
    if (s.type === 'contact') return { ...s, data: { ...s.data, groups: data.disciplines } };
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

/**
 * The contact page (UI v2 PR9): banner hero → inquiry form → direct channels → FAQ.
 * Mirrored by the seeded composition (supabase/seed-data/52-contact.json;
 * tests/lib/contactPage.spec.ts holds the two together). The hero carries no content here:
 * its copy and its banner layout come from `withHeroPreset(…, 'contact')`, which the route
 * applies to whatever composition renders — authored or this default.
 */
export const DEFAULT_CONTACT_SECTIONS: SectionData[] = [
  { type: 'hero' },
  { type: 'contactInquiry' },
  { type: 'contactChannels' },
  { type: 'faq' },
];

/** A preset's layout — handed to the hero as route `data`, which CMS content cannot replace. */
export interface HeroPresetData {
  /** The short banner hero: shorter box, badge CTA first, no scroll cue, never the intro. */
  banner: true;
  /** Where the CTA points: the page's own form (contact) or its first band (services). */
  ctaHref: string;
  /** The window of the loop this page plays, so it does not replay the home opening. */
  clip?: { start: number; end: number };
  /** The small line under the CTA (Hero `data.altLink`, Round 2) — its `<b>` run is split, never injected. */
  altLink?: { label: HeroText; href: string };
}

/**
 * Per-page hero presets (a CODE-only argument, never stored — lead contract). `content` is
 * the page's built-in copy, verbatim from the design; `data` is its layout.
 */
export const HERO_PRESETS = {
  contact: {
    content: {
      headline: { en: "Let's make it happen", ar: 'خلّنا نحقّقها' },
      accentFromEn: 3,
      accentFromAr: 1,
      sub: {
        en: "Strategy, creative, and production under one roof. Tell us where you want to go, and we'll take it from there.",
        ar: 'استراتيجية وإبداع وإنتاج تحت سقف واحد. قل لنا وين تبي توصل، والباقي علينا.',
      },
      ctaLabel: { en: 'Start your project', ar: 'ابدأ مشروعك' },
    },
    // The design's contact loop: 6.2–7.9 s of the showreel, "so this page doesn't replay
    // the homepage opening".
    data: { banner: true, ctaHref: '#inquiry', clip: { start: 6.2, end: 7.9 } },
  },
  // Round 2: /services — services.html `s.h1` / `s.sub` / `s.cta` / `s.alt`, verbatim.
  // "Ideas, made <em>real</em>" / "أفكار، صارت <em>حقيقة</em>": the accent is the third word.
  services: {
    content: {
      headline: { en: 'Ideas, made real', ar: 'أفكار، صارت حقيقة' },
      accentFromEn: 2,
      accentFromAr: 2,
      sub: {
        en: 'Branding, production, marketing, websites, and events. One team takes your idea from the first sketch to the day it goes live.',
        ar: 'هوية، وإنتاج، وتسويق، ومواقع، وفعاليات. فريق واحد ياخذ فكرتك من أول رسمة إلى يوم إطلاقها.',
      },
      ctaLabel: { en: 'Explore our services', ar: 'استكشف خدماتنا' },
    },
    // The design's services loop (HERO_SEG): 13.4–15.9 s. The CTA opens the discipline
    // cards; the alt link skips to the page's own "Say hello" form. The route re-points
    // both when the band they name is not on the page (servicesPageLinks).
    data: {
      banner: true,
      ctaHref: '#categories',
      clip: { start: 13.4, end: 15.9 },
      altLink: {
        label: {
          en: 'Know what you need? <b>Skip to the inquiry</b>',
          ar: 'عارف وش تحتاج؟ <b>انتقل للطلب مباشرة</b>',
        },
        href: '#inquiry',
      },
    },
  },
} as const satisfies Record<
  string,
  {
    content: {
      headline: { en: string; ar: string };
      accentFromEn: number;
      accentFromAr: number;
      sub: { en: string; ar: string };
      ctaLabel: { en: string; ar: string };
    };
    data: HeroPresetData;
  }
>;
export type HeroPreset = keyof typeof HERO_PRESETS;

/**
 * Applies a page's hero preset to its FIRST hero — the contact page's fix: with no content
 * the hero fell back to the HOME copy ("Creative work that performs*", "See our work").
 *
 * Mirrors `withHomeIntro`: the preset's copy is a default under whatever the CMS authored
 * (an authored field wins), and its layout goes in as route data (the CMS cannot turn the
 * banner off or point its button elsewhere). The accent indices belong to the headline
 * they were counted against, so an authored headline never inherits the preset's.
 */
export function withHeroPreset(
  sections: readonly SectionData[],
  preset: HeroPreset,
): SectionData[] {
  const { content, data } = HERO_PRESETS[preset];
  let applied = false;
  return sections.map((s) => {
    if (applied || s.type !== 'hero') return s;
    applied = true;
    const authored = s.props ?? {};
    const { headline, accentFromEn, accentFromAr, ...rest } = content;
    const copy: Record<string, unknown> =
      'headline' in authored ? rest : { headline, accentFromEn, accentFromAr, ...rest };
    return { ...s, props: { ...copy, ...authored }, data: { ...s.data, ...data } };
  });
}

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

/**
 * The Services page (`/services`, Round 2), in the design's order: banner hero → proof
 * (the `services` statistics variant) → the discipline cards (page mode) → the explorer →
 * "Say hello". Mirrored by the seeded composition (supabase/seed-data/54-services-page.json;
 * tests/lib/servicesPage.spec.ts holds the two together, the seed's sample `rating` aside).
 * The hero carries no content: its copy and banner layout come from
 * `withHeroPreset(…, 'services')`.
 *
 * The proof band's rating line ("4.9 / 5 average client rating") is NOT here. It is a claim
 * with no table behind it (the design's sample), so it exists only in the seeded row, which
 * is flagged `is_placeholder` for it: the 0025 fence keeps that row off production until
 * the owner makes it real or overrides (runbook §6d). This default renders whenever the
 * composition comes back empty (the page unpublished, every section hidden, a failed read),
 * and code is never behind that fence: a sample claim here would reach production, and the
 * Tier A edge cache, unflagged. The band still hides with its numbers: fewer published
 * `services` counters than two and nothing renders.
 */
export const DEFAULT_SERVICES_SECTIONS: SectionData[] = [
  { type: 'hero' },
  { type: 'statistics', props: { variant: 'services', placement: 'services' } },
  { type: 'servicesOverview' },
  { type: 'serviceExplorer' },
  { type: 'hello' },
];

/** All projects (`/portfolio/all`, UI v2 PR10). */
export const DEFAULT_CATALOG_SECTIONS: SectionData[] = [
  { type: 'pageHead' },
  { type: 'projectCatalog' },
  { type: 'cta' },
];
