import type { SectionType } from './sectionTypes';

// A page section's appearance (Admin v2 E9): a background, a spacing and a reveal, each a
// closed bucket stored on the row (`page_sections.background`, `.spacing`, `.reveal`), and an
// editable anchor (`page_sections.anchor`). Null is the section's own look: a section with
// nothing chosen renders byte for byte as it did before E9.
//
// ONE code map, dependency-free (no zod), so the write schema (packages/schemas/admin.ts), the
// Worker's rules (src/lib/admin/resources/sections.ts), the renderer (SectionRenderer through
// src/lib/sections/appearance.ts) and the page editor's Appearance card all read the same lists.
// The E9 migration's CHECKs hold the same values and kinds; tests/lib/sectionAppearance.spec.ts
// reads them out of the migration and holds them equal to these.
//
// Which kinds take which choice, and why:
//   background  E10's paper blocks only. Their every colour is read through the variant's
//               scoped rules in global.css, which the contrast gate checks pair by pair
//               (scripts/contrast-audit.mjs, "E9"). A designed band's colours are its design:
//               each would need its own variant rules, pairs and baselines.
//   spacing     the three blocks: their padding is one rule each. A designed band's spacing is
//               its layout.
//   reveal      every kind but the ones that open a page (CLAUDE.md §6: an LCP element, or
//               anything that starts visible, is never reveal-gated): the heading group (the
//               hero, the Story, Who we are, the Page head), Our Work's banner and the Slogan,
//               which runs its own scroll animation. The renderer also ignores a reveal on the
//               first REVEAL_OPENING sections a page shows, whatever their kind.
//   anchor      every kind whose component does not name its own anchor (CODE_ANCHORED below)
//               and is not the hero (its first element can be the home page's intro plate).

/** The backgrounds a section may choose, besides its own (null). */
export const SECTION_BACKGROUNDS = ['mist', 'ink', 'klein'] as const;
export type SectionBackground = (typeof SECTION_BACKGROUNDS)[number];

/** The spacings a section may choose, besides its own (null). */
export const SECTION_SPACINGS = ['compact', 'roomy'] as const;
export type SectionSpacing = (typeof SECTION_SPACINGS)[number];

/** The reveals a section may choose, besides none (null). */
export const SECTION_REVEALS = ['fade', 'rise'] as const;
export type SectionReveal = (typeof SECTION_REVEALS)[number];

/** The kinds that take a background. */
export const BACKGROUND_TYPES = ['textBlock', 'gallery'] as const satisfies readonly SectionType[];

/** The kinds that take a spacing. */
export const SPACING_TYPES = [
  'textBlock',
  'gallery',
  'video',
] as const satisfies readonly SectionType[];

/** The kinds that never take a reveal: they open a page (§6), or move on their own. */
export const NO_REVEAL_TYPES = [
  'hero',
  'aboutStory',
  'aboutWho',
  'pageHead',
  'workHero',
  'slogan',
] as const satisfies readonly SectionType[];

/**
 * How many of a page's shown sections open it: a reveal on one of them is ignored at render.
 * A banner hero is short, so the section under it is in the first screen (Contact's and Join's
 * measured LCP element is that section's heading, CLAUDE.md §6).
 */
export const REVEAL_OPENING = 2;

/**
 * The kinds whose component always names its own anchor on its first element (the `id` other
 * code links to: `#inquiry`, `#apply`, `#projects`…): an editable anchor is not offered, and
 * the editor shows theirs. The Numbers band (`statistics` in its `band` look) names `#numbers`;
 * that one depends on the look, so it is CODE_ANCHORED_LOOK.
 * tests/render/sectionAppearance.spec.ts renders every kind and holds this list to the markup.
 */
export const CODE_ANCHORED_TYPES = [
  'aboutIntro',
  'aboutWho',
  'clientsMarquee',
  'contact',
  'contactInquiry',
  'faq',
  'hello',
  'joinApply',
  'leadership',
  'projectCatalog',
  'projectGrid',
  'selectedWork',
  'servicesOverview',
  'testimonials',
] as const satisfies readonly SectionType[];

/** A kind whose anchor depends on its look: the Numbers band. */
export const CODE_ANCHORED_LOOK = { type: 'statistics', variant: 'band' } as const;

/** The kinds that never take an editable anchor besides the code-anchored ones. */
export const NO_ANCHOR_TYPES = ['hero'] as const satisfies readonly SectionType[];

/** An anchor's longest length. */
export const ANCHOR_MAX = 40;

/** An anchor's shape: lower-case letters and digits, words joined by single hyphens. */
export const ANCHOR_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * Ids the site's own code renders on a page the CMS composes, which an anchor may never take:
 * the layout's (`main`, the skip link's target; `content`, the admin's; `consent-banner`), the
 * code anchors of every section (taken on every page, since any section may be added later),
 * the forms' and the catalogue's fixed ids, the case study's and search's, and `top` (a browser
 * scrolls `#top` to the top of the page when no element has it).
 */
export const RESERVED_ANCHORS = [
  'about',
  'apply',
  'apply-form',
  'apply-lead',
  'apply-status',
  'case',
  'catalog-count',
  'categories',
  'clients',
  'consent-banner',
  'contact',
  'contact-form',
  'contact-status',
  'content',
  'faq',
  'home-contact-cta',
  'inquiry',
  'main',
  'numbers',
  'projects',
  'quotes',
  'search-form',
  'search-input',
  'search-results',
  'selected-work',
  'services',
  'team',
  'team-track',
  'testimonials',
  'title',
  'top',
  'what',
  'who',
] as const;

/** Prefixes of ids the code makes (form controls, the explorer, the footer's columns…). */
export const RESERVED_ANCHOR_PREFIXES = [
  'af-',
  'cf-',
  'cs-',
  'pv-',
  'site-footer-',
  'svc-',
  'tm-',
] as const;

/** Endings of ids the code makes (headings, a form's errors, the explorer's panel headings). */
export const RESERVED_ANCHOR_SUFFIXES = ['-error', '-h', '-heading'] as const;

/** Whether an id is one the site's code renders (by name, prefix or ending). */
export function anchorReserved(id: string): boolean {
  if ((RESERVED_ANCHORS as readonly string[]).includes(id)) return true;
  if (RESERVED_ANCHOR_PREFIXES.some((p) => id.startsWith(p))) return true;
  return RESERVED_ANCHOR_SUFFIXES.some((s) => id.endsWith(s));
}

/** Why an anchor is refused, in an editor's words, or null when its shape is right. */
export function anchorProblem(anchor: string): string | null {
  if (anchor.length === 0) return 'Write an anchor, or leave the box empty for none.';
  if (anchor.length > ANCHOR_MAX) return `An anchor is ${ANCHOR_MAX} characters at most.`;
  if (!ANCHOR_PATTERN.test(anchor)) {
    return 'Use lower-case letters and numbers, with single hyphens between words, starting with a letter (our-story).';
  }
  if (anchorReserved(anchor)) {
    return `#${anchor} is used by the site itself. Choose another anchor.`;
  }
  return null;
}

/** Why an anchor that another section of the page holds is refused. */
export const ANCHOR_TAKEN = 'Another section of this page already has this anchor. Choose another.';

/** Why an anchor that a discipline's slug holds is refused (the explorer's panels use them). */
export const ANCHOR_DISCIPLINE =
  'A discipline uses this name on the Services page. Choose another anchor.';

/** Why an anchor on a section that names its own is refused. */
export const ANCHOR_CODE_OWNED =
  'This section has its own anchor, set by the site, which other links point at.';

const has = (list: readonly string[], value: string) => list.includes(value);

/** Whether a kind takes a background. */
export const takesBackground = (type: string): boolean => has(BACKGROUND_TYPES, type);
/** Whether a kind takes a spacing. */
export const takesSpacing = (type: string): boolean => has(SPACING_TYPES, type);
/** Whether a kind takes a reveal. */
export const takesReveal = (type: string): boolean => !has(NO_REVEAL_TYPES, type);

/** Why a page-opening kind takes no reveal (§6). */
export const REVEAL_OPENS_PAGE =
  'This kind of section opens a page, so it always shows at once: it takes no reveal.';
/** Why the Slogan takes no reveal: it opens nothing, but runs its own scroll animation. */
export const REVEAL_MOVES_ITSELF =
  'This section moves on its own as you scroll: it takes no reveal.';
/**
 * The database's refusal (0127's reveal CHECK), which cannot say which kind it refused: true of
 * every kind NO_REVEAL_TYPES names.
 */
export const REVEAL_REFUSED =
  'This kind of section takes no reveal: it opens a page, or moves on its own as you scroll.';

/** Why a kind takes no reveal, in its own words, or null when it takes one. */
export function revealRefusal(type: string): string | null {
  if (takesReveal(type)) return null;
  return type === 'slogan' ? REVEAL_MOVES_ITSELF : REVEAL_OPENS_PAGE;
}

/**
 * The anchor a kind's component names itself in a look, or null. Only whether it has one is
 * read here (the editor's library names it, `anchorOf`).
 */
export function codeAnchored(type: string, variant: unknown): boolean {
  if (has(CODE_ANCHORED_TYPES, type)) return true;
  return type === CODE_ANCHORED_LOOK.type && variant === CODE_ANCHORED_LOOK.variant;
}

/** Whether a section of a kind, in a look, takes an editable anchor. */
export function takesAnchor(type: string, variant: unknown): boolean {
  return !has(NO_ANCHOR_TYPES, type) && !codeAnchored(type, variant);
}

/** The appearance a section carries (each member set only when chosen). */
export interface SectionAppearance {
  background?: SectionBackground;
  spacing?: SectionSpacing;
  reveal?: SectionReveal;
  anchor?: string;
}

/** Why a chosen background, spacing or reveal is refused for a kind, or null. */
export function appearanceProblem(
  type: string,
  chosen: { background?: unknown; spacing?: unknown; reveal?: unknown },
): { field: 'background' | 'spacing' | 'reveal'; message: string } | null {
  if (chosen.background != null && !takesBackground(type)) {
    return {
      field: 'background',
      message: 'This kind of section keeps its own background: its colours are part of its design.',
    };
  }
  if (chosen.spacing != null && !takesSpacing(type)) {
    return {
      field: 'spacing',
      message: 'This kind of section keeps its own spacing: it is part of its layout.',
    };
  }
  const noReveal = chosen.reveal != null ? revealRefusal(type) : null;
  if (noReveal) return { field: 'reveal', message: noReveal };
  return null;
}
