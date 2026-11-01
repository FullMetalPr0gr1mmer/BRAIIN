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
// type's component (F6 built that, and nothing else reads them yet). The page editor (E1,
// AV-25) is to read them on the server and hand them to its fields as props, so they add
// nothing to the admin bundle and the fields show the words a visitor reads.
//
// `content` holds, per look, the built-in values in the shape of the type's CMS content
// (packages/schemas/sections.ts), field for field: each parses as that type's content, and
// every text field of the type has a built-in or a stated reason not to
// (tests/lib/sectionCopy.spec.ts). A type with one look has `default`; the others are keyed
// by what picks the look (builtInContent below). `labels` is the text a type renders that no
// content field holds (accessible names, controls, patterns around data).
//
// What holds when copy is stored (tests/render/sectionCopy.spec.ts), so an editor may store
// only what differs from it: stored as the section's content, a whole look renders exactly
// what the section renders with none, and so does any one storage unit of it stored alone at
// its built-in value. A unit is a `together` group, or any other field on its own. A single
// field of a group is NOT such a unit: an accent counts the words of its own heading, so an
// editor that changes either stores the group. The `notVerbatim` fields are in no unit.

/** One section type's built-in copy. */
export interface SectionCopy {
  /** Per look: the built-in content, in the shape of the type's CMS content. */
  readonly content: Readonly<Record<string, object>>;
  /** Text the type renders that no content field overrides. */
  readonly labels: Readonly<Record<string, LocalizedText>>;
  /**
   * Content fields whose built-in value the type does not render the same way when it is
   * authored: the built-in names the studio through `%brand%` or bolds a `<b>` run, and
   * the type renders an authored value as plain text. Stored as written, such a value
   * would read "%brand%" or show the tags, so the page editor must show it without storing
   * it (AV-25). The public behaviour is unchanged by F6.
   */
  readonly notVerbatim: readonly string[];
  /**
   * Groups of content fields the type reads only together, to be stored whole: when any
   * field of a group differs from its built-in value, every field of the group is stored.
   * An accent counts words of its own heading, so a type renders an authored heading with
   * only an authored accent (none when none is stored), and the hero, the discipline cards,
   * hello, the Join bands and the services proof line read an authored accent only beside
   * an authored heading. Stored alone, either field renders other than its built-in.
   */
  readonly together: readonly (readonly string[])[];
}

type More = Partial<Omit<SectionCopy, 'content'>>;

/** A type's copy: its looks, and what it declares about them. */
const looks = (
  content: Readonly<Record<string, object>>,
  { labels = {}, notVerbatim = [], together = [] }: More = {},
): SectionCopy => ({ content, labels, notVerbatim, together });

/** A type with one look. */
const one = (content: object, more: More = {}): SectionCopy => looks({ default: content }, more);

/** The heading and its accent range, stored together. */
const HEADING: More = { together: [['heading', 'accent']] };

export const SECTION_COPY: Readonly<Record<RenderedSectionType, SectionCopy>> = {
  // By page: the hero on contact, services and join takes that page's preset.
  hero: looks(HERO_COPY, {
    labels: HERO_LABELS,
    together: [['headline', 'accentFromEn', 'accentFromAr']],
  }),
  // By the route's mode: `page` on /services, `home` anywhere else.
  servicesOverview: looks(SERVICES_OVERVIEW_COPY, HEADING),
  cta: one(CTA_COPY, HEADING),
  // By the section's `variant`.
  social: looks(SOCIAL_COPY, HEADING),
  aboutStory: one(ABOUT_STORY_COPY),
  // By the section's `variant` (`cards` when it has none).
  statistics: looks(STATISTICS_COPY, {
    together: [
      ['heading', 'accent'],
      ['line', 'lineAccent'],
    ],
  }),
  team: one({}, { labels: TEAM_LABELS }),
  certifications: one({}, { labels: CERTIFICATIONS_LABELS }),
  clientsMarquee: one(CLIENTS_MARQUEE_COPY, { labels: CLIENTS_MARQUEE_LABELS }),
  // "Why %brand%" and the heading's <b> run: an authored tag and heading are plain text.
  aboutIntro: one(ABOUT_INTRO_COPY, { notVerbatim: ['tag', 'heading'] }),
  slogan: one(SLOGAN_COPY),
  contact: one(CONTACT_COPY),
  contactInquiry: one(CONTACT_INQUIRY_COPY, HEADING),
  contactChannels: one(CONTACT_CHANNELS_COPY, HEADING),
  faq: one(FAQ_COPY, HEADING),
  selectedWork: one(SELECTED_WORK_COPY, HEADING),
  testimonials: one(TESTIMONIALS_COPY, { ...HEADING, labels: TESTIMONIALS_LABELS }),
  aboutWho: one(ABOUT_WHO_COPY, HEADING),
  leadership: one(LEADERSHIP_COPY, { ...HEADING, labels: LEADERSHIP_LABELS }),
  workHero: one(WORK_HERO_COPY, { labels: WORK_HERO_LABELS }),
  // The quotes' heading and accent, as testimonials' own.
  proof: one(PROOF_COPY, { together: [['quotesHeading', 'quotesAccent']] }),
  workIntro: one(WORK_INTRO_COPY),
  projectGrid: one(PROJECT_GRID_COPY),
  pageHead: one(PAGE_HEAD_COPY, HEADING),
  projectCatalog: one(PROJECT_CATALOG_COPY),
  hello: one(HELLO_COPY, HEADING),
  serviceExplorer: one(SERVICE_EXPLORER_COPY, { labels: SERVICE_EXPLORER_LABELS }),
  joinWhy: one(JOIN_WHY_COPY, HEADING),
  joinSteps: one(JOIN_STEPS_COPY, HEADING),
  joinApply: one(JOIN_APPLY_COPY, HEADING),
  // Admin v2 E10: no built-in copy. A block shows what is written in it, and nothing when
  // nothing is (tests/lib/sectionCopy.spec.ts NO_BUILT_IN says so field by field), so the
  // page editor's fields start empty and a forgotten block puts no placeholder on a page.
  textBlock: one({}),
  gallery: one({}),
  video: one({}),
};

/**
 * Where a section is: the slug of its page, its content's `variant` if it has one, and
 * whether it is the first section of its type in the page's composition (hidden ones
 * count). A page preset dresses the first hero only (withHeroPreset), so a later hero on
 * contact, services or join renders the home copy. Omitted, `firstOfType` means first.
 */
export interface SectionPlace {
  page?: string | undefined;
  variant?: unknown;
  firstOfType?: boolean | undefined;
}

const HERO_PRESET_PAGES: readonly string[] = ['contact', 'services', 'join'];
const STAT_VARIANTS: readonly unknown[] = STAT_BAND_VARIANTS;

/** Which of a type's looks a section in `place` renders. */
export function builtInLook(type: RenderedSectionType, place: SectionPlace = {}): string {
  switch (type) {
    case 'hero':
      return place.firstOfType !== false && place.page && HERO_PRESET_PAGES.includes(place.page)
        ? place.page
        : 'default';
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
 * for field, which the page editor (E1, AV-25) is to prefill its fields with.
 */
export function builtInContent(
  type: RenderedSectionType,
  place: SectionPlace = {},
): Readonly<Record<string, unknown>> {
  const looks = SECTION_COPY[type].content;
  return (looks[builtInLook(type, place)] ?? {}) as Readonly<Record<string, unknown>>;
}
