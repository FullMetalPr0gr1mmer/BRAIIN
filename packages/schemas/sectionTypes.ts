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
  // Admin v2 E10: blocks any page may take (a text block, a picture grid, a film window)
  'textBlock',
  'gallery',
  'video',
] as const;
export type SectionType = (typeof SECTION_TYPES)[number];

/**
 * A section's name in the admin (Admin v2 E1): `page_sections.label`, at most this many
 * characters, trimmed, no control or format character (0115's CHECK). Null shows the type's own
 * name. Set by the page editor's Rename dialog; no public page renders it.
 */
export const SECTION_LABEL_MAX = 60;

/**
 * The section types that are media blocks (Admin v2 E10): a Gallery holds up to twelve pictures,
 * a Video a still and a film. A page holds at most MEDIA_BLOCKS_PER_PAGE of them together,
 * hidden ones included (sectionResource.assertWritable, judged on the merged or staged view;
 * Add section says so first). The page's section media are read in ONE request whatever the
 * count (SectionRenderer), so the cap bounds that request's ids and the page's pictures, not
 * its subrequests.
 */
export const MEDIA_BLOCK_TYPES = ['gallery', 'video'] as const satisfies readonly SectionType[];
export const MEDIA_BLOCKS_PER_PAGE = 8;

/** Why a page takes no more of them, in an editor's words (the API's 422 and Add section's). */
export const MEDIA_BLOCKS_FULL =
  'A page holds 8 galleries and videos at most, together. Remove one before adding another.';
