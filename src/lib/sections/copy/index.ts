import type { LocalizedText } from '@schemas/content';
import { STAT_BAND_VARIANTS } from '@schemas/sections';
import type { RenderedSectionType } from '../registry';
import { ABOUT_INTRO_COPY } from './aboutIntro';
import { ABOUT_STORY_COPY } from './aboutStory';
import { ABOUT_WHO_COPY } from './aboutWho';
import { CERTIFICATIONS_LABELS } from './certifications';
import { CLIENTS_MARQUEE_COPY, CLIENTS_MARQUEE_LABELS } from './clientsMarquee';
import { CONTACT_COPY } from './contact';
import { CONTACT_CHANNELS_COPY } from './contactChannels';
import { CONTACT_INQUIRY_COPY } from './contactInquiry';
import { CTA_COPY } from './cta';
import { FAQ_COPY } from './faq';
import { HELLO_COPY } from './hello';
import { HERO_COPY, HERO_LABELS } from './hero';
import { JOIN_APPLY_COPY } from './joinApply';
import { JOIN_STEPS_COPY } from './joinSteps';
import { JOIN_WHY_COPY } from './joinWhy';
import { LEADERSHIP_COPY, LEADERSHIP_LABELS } from './leadership';
import { PAGE_HEAD_COPY } from './pageHead';
import { PROJECT_CATALOG_COPY } from './projectCatalog';
import { PROJECT_GRID_COPY } from './projectGrid';
import { PROOF_COPY } from './proof';
import { SELECTED_WORK_COPY } from './selectedWork';
import { SERVICE_EXPLORER_COPY, SERVICE_EXPLORER_LABELS } from './serviceExplorer';
import { SERVICES_OVERVIEW_COPY } from './servicesOverview';
import { SLOGAN_COPY } from './slogan';
import { SOCIAL_COPY } from './social';
import { STATISTICS_COPY } from './statistics';
import { TEAM_LABELS } from './team';
import { TESTIMONIALS_COPY, TESTIMONIALS_LABELS } from './testimonials';
import { WORK_HERO_COPY, WORK_HERO_LABELS } from './workHero';
import { WORK_INTRO_COPY } from './workIntro';

// Every section type's built-in copy (Admin v2 F6, ui.md AV-23): what a section renders when
// its CMS content leaves a field out. One module per type beside this one, imported by the
// type's component, so the text a visitor reads and the text the page editor shows are the
// same values. The editor reads them on the server and hands them to its fields as props, so
// they add nothing to the admin bundle; a field left equal to its built-in value is not
// stored.
//
// `content` holds, per look, the built-in values in the shape of the type's CMS content
// (packages/schemas/sections.ts), field for field: each parses as that type's content
// (tests/lib/sectionCopy.spec.ts). A type with one look has `default`; the others are keyed
// by what picks the look (builtInContent below). `labels` is the text a type renders that
// no content field holds (accessible names, controls, patterns around data).

/** One section type's built-in copy. */
export interface SectionCopy {
  /** Per look: the built-in content, in the shape of the type's CMS content. */
  readonly content: Readonly<Record<string, object>>;
  /** Text the type renders that no content field overrides. */
  readonly labels: Readonly<Record<string, LocalizedText>>;
}

const one = (content: object, labels: Readonly<Record<string, LocalizedText>> = {}) => ({
  content: { default: content },
  labels,
});

export const SECTION_COPY: Readonly<Record<RenderedSectionType, SectionCopy>> = {
  // By page: the hero on contact, services and join takes that page's preset.
  hero: { content: HERO_COPY, labels: HERO_LABELS },
  // By the route's mode: `page` on /services, `home` anywhere else.
  servicesOverview: { content: SERVICES_OVERVIEW_COPY, labels: {} },
  cta: one(CTA_COPY),
  // By the section's `variant`.
  social: { content: SOCIAL_COPY, labels: {} },
  aboutStory: one(ABOUT_STORY_COPY),
  // By the section's `variant` (`cards` when it has none).
  statistics: { content: STATISTICS_COPY, labels: {} },
  team: one({}, TEAM_LABELS),
  certifications: one({}, CERTIFICATIONS_LABELS),
  clientsMarquee: one(CLIENTS_MARQUEE_COPY, CLIENTS_MARQUEE_LABELS),
  aboutIntro: one(ABOUT_INTRO_COPY),
  slogan: one(SLOGAN_COPY),
  contact: one(CONTACT_COPY),
  contactInquiry: one(CONTACT_INQUIRY_COPY),
  contactChannels: one(CONTACT_CHANNELS_COPY),
  faq: one(FAQ_COPY),
  selectedWork: one(SELECTED_WORK_COPY),
  testimonials: one(TESTIMONIALS_COPY, TESTIMONIALS_LABELS),
  aboutWho: one(ABOUT_WHO_COPY),
  leadership: one(LEADERSHIP_COPY, LEADERSHIP_LABELS),
  workHero: one(WORK_HERO_COPY, WORK_HERO_LABELS),
  proof: one(PROOF_COPY),
  workIntro: one(WORK_INTRO_COPY),
  projectGrid: one(PROJECT_GRID_COPY),
  pageHead: one(PAGE_HEAD_COPY),
  projectCatalog: one(PROJECT_CATALOG_COPY),
  hello: one(HELLO_COPY),
  serviceExplorer: one(SERVICE_EXPLORER_COPY, SERVICE_EXPLORER_LABELS),
  joinWhy: one(JOIN_WHY_COPY),
  joinSteps: one(JOIN_STEPS_COPY),
  joinApply: one(JOIN_APPLY_COPY),
};

/** Where a section is: the slug of its page, and its content's `variant` if it has one. */
export interface SectionPlace {
  page?: string | undefined;
  variant?: unknown;
}

const HERO_PRESET_PAGES: readonly string[] = ['contact', 'services', 'join'];
const STAT_VARIANTS: readonly unknown[] = STAT_BAND_VARIANTS;

/** Which of a type's looks a section in `place` renders. */
export function builtInLook(type: RenderedSectionType, place: SectionPlace = {}): string {
  switch (type) {
    case 'hero':
      return place.page && HERO_PRESET_PAGES.includes(place.page) ? place.page : 'default';
    case 'servicesOverview':
      return place.page === 'services' ? 'page' : 'home';
    case 'social':
      return place.variant === 'klein' ? 'klein' : 'paper';
    case 'statistics':
      return STAT_VARIANTS.includes(place.variant) ? String(place.variant) : 'cards';
    default:
      return 'default';
  }
}

/**
 * The built-in content of a section in `place`: what it renders with `content: {}`, field
 * for field, which the page editor prefills its fields with.
 */
export function builtInContent(
  type: RenderedSectionType,
  place: SectionPlace = {},
): Readonly<Record<string, unknown>> {
  const looks = SECTION_COPY[type].content;
  return (looks[builtInLook(type, place)] ?? {}) as Readonly<Record<string, unknown>>;
}
