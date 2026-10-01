// Every section type the site knows — THE contract between the CMS and the renderer.
//
// Its own dependency-free module (no zod) so the admin UI description can import the list
// without dragging every section content schema into the admin client bundle.
//
// Writes are validated against it (packages/schemas/admin.ts SectionWriteSchema: an unknown
// type is a 422, not a row the renderer silently skips), and src/lib/sections/registry.ts's
// RENDERED_SECTION_TYPES must equal it (tests/lib/sectionRegistry.spec.ts) — which
// `astro check` in turn holds the SectionRenderer map to. A new section type starts HERE.
export const SECTION_TYPES = [
  'hero',
  'aboutIntro',
  'slogan',
  'clientsMarquee',
  'servicesOverview',
  'contact',
  'social',
  'cta',
  'aboutStory',
  'statistics',
  'team',
  'certifications',
  'contactInquiry',
  'contactChannels',
  'faq',
  // UI v2 PR7 (home)
  'selectedWork',
  'testimonials',
  // UI v2 PR8 (About)
  'aboutWho',
  'leadership',
  // UI v2 PR10 — Our Work (/portfolio) and All projects (/portfolio/all)
  'workHero',
  'proof',
  'workIntro',
  'projectGrid',
  'pageHead',
  'projectCatalog',
  // Round 2 (services): the "Say hello" inquiry block closing the services pages, and the
  // /services explorer (one panel per discipline, listing its services)
  'hello',
  'serviceExplorer',
  // Join (/join): why join, the hiring steps, and the application band around the form
  // (the form itself is code — ApplicationForm.astro — never content)
  'joinWhy',
  'joinSteps',
  'joinApply',
] as const;
export type SectionType = (typeof SECTION_TYPES)[number];
