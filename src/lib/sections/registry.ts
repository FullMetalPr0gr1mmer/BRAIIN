import type { SectionType } from '@schemas/sectionTypes';

// The section types SectionRenderer.astro actually has a component for.
//
// Kept in a plain .ts module so a test can read it (vitest has no Astro plugin, so the
// .astro map itself is unreachable from a spec). The two halves are then held together
// from both sides:
//   * SectionRenderer types its map as Record<RenderedSectionType, …>, so `astro check`
//     fails if a type listed here has no component, or a component has no entry here;
//   * tests/lib/sectionRegistry.spec.ts fails if this list and packages/schemas'
//     SECTION_TYPES (what the CMS accepts) disagree — a type the CMS accepts but nothing
//     renders is a section an editor saves and a visitor never sees.
export const RENDERED_SECTION_TYPES = [
  'hero',
  'servicesOverview',
  'cta',
  'social',
  'aboutStory',
  'statistics',
  'team',
  'certifications',
  'clientsMarquee',
  'aboutIntro',
  'slogan',
  'contact',
  'contactInquiry',
  'contactChannels',
  'faq',
  // UI v2 PR7 (home)
  'selectedWork',
  'testimonials',
  // UI v2 PR8 (About)
  'aboutWho',
  'leadership',
  // UI v2 PR10 — Our Work and All projects
  'workHero',
  'proof',
  'workIntro',
  'projectGrid',
  'pageHead',
  'projectCatalog',
  // Round 2 (services)
  'hello',
  'serviceExplorer',
  // Join
  'joinWhy',
  'joinSteps',
  'joinApply',
] as const satisfies readonly SectionType[];

export type RenderedSectionType = (typeof RENDERED_SECTION_TYPES)[number];

const RENDERED = new Set<string>(RENDERED_SECTION_TYPES);
export const isRenderedSectionType = (type: string): type is RenderedSectionType =>
  RENDERED.has(type);
