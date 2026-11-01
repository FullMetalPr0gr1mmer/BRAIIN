import type { SectionType } from '@schemas/sectionTypes';
import type { SectionData } from './types';

// What each section type reads, as Cache-Tags (Admin v2 R7; docs/admin-v2/releases.md §5.2).
// An editor can add a table-backed section (statistics, a team grid, quotes, certifications,
// the FAQ...) to any composed page, so a route's own tag list cannot know every table it
// renders: About stamped `team:all` and `statistics:all` but not `certifications:all`, so a
// certification published through a release would never have purged it. Every composed Tier A
// route stamps its own tags plus `sectionTags(sections)` of the sections it renders.
//
// The tags are the vocabulary the release registry emits (src/lib/release/registry.ts) and the
// media saves emit (`media:all`): tests/lib/sectionReads.spec.ts holds every tag here to one
// something purges, and every route's whole set within the 30 a purge allows.
//
// A section's data comes from the loader its component calls, or the route hands it the same
// read as `data`; either way the tables are the loader's:
//   • portfolio cards (getPortfolioCards): the projects, their sector, client and services,
//     the poster image;
//   • disciplines (getPublishedDisciplines): the disciplines, their published services, the
//     poster image;
//   • the public identity (getIdentity) and the menus are on every page already
//     (`site:identity`, `nav:all`, src/lib/http/cacheTags.ts);
//   • a section that renders one of the two forms reads the forms config (Admin v2 E8,
//     `form_settings`): `forms:all`.

const CARDS = ['portfolio:all', 'sectors:all', 'clients:all', 'services:all', 'media:all'];
const DISCIPLINES = ['disciplines:all', 'services:all', 'media:all'];
/** A section with the inquiry form: its "What do you need?" select and the forms config. */
const INQUIRY = [...DISCIPLINES, 'forms:all'];

export const SECTION_READS: Readonly<Record<SectionType, readonly string[]>> = {
  // Copy, the site's clip registry and the identity.
  hero: [],
  aboutIntro: [],
  slogan: [],
  // The marquee's client names and logos.
  clientsMarquee: ['clients:all', 'media:all'],
  servicesOverview: DISCIPLINES,
  // The home inquiry's grouped "What do you need?" select, and the form's config.
  contact: INQUIRY,
  social: [],
  cta: [],
  aboutStory: [],
  statistics: ['statistics:all'],
  // Names, bios and portraits.
  team: ['team:all', 'media:all'],
  certifications: ['certifications:all'],
  contactInquiry: INQUIRY,
  contactChannels: [],
  faq: ['faq:all'],
  selectedWork: CARDS,
  // The quotes and their avatars.
  testimonials: ['testimonials:all', 'media:all'],
  // Its image (a media row by id).
  aboutWho: ['media:all'],
  leadership: ['team:all', 'media:all'],
  workHero: CARDS,
  // The numbers and a quote.
  proof: ['statistics:all', 'testimonials:all', 'media:all'],
  workIntro: ['media:all'],
  projectGrid: CARDS,
  pageHead: [],
  projectCatalog: CARDS,
  hello: INQUIRY,
  serviceExplorer: DISCIPLINES,
  joinWhy: [],
  joinSteps: [],
  // The Join form, as the forms config words it.
  joinApply: ['forms:all'],
};

/** The tags of the sections a page renders (a hidden section renders nothing), each once. */
export function sectionTags(sections: readonly Pick<SectionData, 'type' | 'visible'>[]): string[] {
  const out = new Set<string>();
  for (const section of sections) {
    if (section.visible === false) continue;
    const reads = Object.hasOwn(SECTION_READS, section.type)
      ? SECTION_READS[section.type as SectionType]
      : undefined;
    for (const tag of reads ?? []) out.add(tag);
  }
  return [...out];
}
