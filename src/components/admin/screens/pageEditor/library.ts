import {
  MEDIA_BLOCKS_FULL,
  MEDIA_BLOCKS_PER_PAGE,
  MEDIA_BLOCK_TYPES,
  SECTION_TYPES,
  type SectionType,
} from '@schemas/sectionTypes';
import { isVisibilityPageSlug, type VisibilityPageSlug } from '@/lib/visibility/routes';
import type { IconName } from '@/lib/admin/icons';

// The page editor's section library (Admin v2 E1, docs/admin-v2/ui.md AV-25): what each
// section type is called, how it is described in "Add section", which pages may take it and
// why one may not, where it is anchored, what the route decides around it, and which screens
// hold the data it shows. A code map built on SECTION_TYPES (packages/schemas/sectionTypes.ts),
// pure and client-safe: the island and its server page both read it, and
// tests/lib/pageEditorLibrary.spec.ts holds it to the list, to the components' anchors and to
// the routes' own rules (withHeroPreset, ensureContactInquiry, ensureJoinApply,
// ensureServiceExplorer, F6's builtInLook).
//
// Which pages take a type. Most section components read their own data, so they render on any
// composed page; the ones bound to a page are bound because the ROUTE gives them what they
// need (the FAQ's questions reach the contact page only), because they belong to that page's
// design (the Join bands, Our Work's banner), or because they hold a fixed anchor another part
// of that page links to (the explorer, the catalogue). Three groups take one member a page:
//   heading   the sections that render the page's <h1> (two would make two);
//   form      the sections that hold a form (their fields' ids are fixed: one form a page);
//   projects  the two project lists (both are the #projects anchor).

/** A CMS page the site routes (`pages.slug`), with its name in the admin. */
export const PAGE_NAMES: Readonly<Record<VisibilityPageSlug, string>> = {
  home: 'Home',
  about: 'About',
  contact: 'Contact',
  join: 'Join',
  services: 'Services',
  portfolio: 'Our Work',
  'portfolio-all': 'All projects',
};

type Group = 'heading' | 'form' | 'projects';

export interface SectionKind {
  /** The type's name in the editor (a section with no label of its own shows it). */
  name: string;
  /** The line under it in "Add section". */
  description: string;
  icon: IconName;
  /** The pages that take it; every routed page when left out. */
  pages?: readonly VisibilityPageSlug[];
  /** At most one a page. */
  once?: boolean;
  /** A group a page takes one member of (see the header). */
  group?: Group;
}

export const SECTION_KINDS: Readonly<Record<SectionType, SectionKind>> = {
  hero: {
    name: 'Hero',
    description: 'The opening band: a big headline, a line under it and a button.',
    icon: 'sparkle',
    group: 'heading',
  },
  aboutIntro: {
    name: 'About intro',
    description: 'Who the studio is, with a few short columns.',
    icon: 'info',
    once: true,
  },
  slogan: {
    name: 'Slogan band',
    description: 'One big line over the showreel.',
    icon: 'type',
  },
  clientsMarquee: {
    name: 'Client names',
    description: 'The moving row of the clients who agreed to be named.',
    icon: 'users',
    once: true,
  },
  servicesOverview: {
    name: 'Disciplines',
    description: 'The five discipline cards, each opening its services.',
    icon: 'layers',
    pages: ['home', 'services'],
    once: true,
  },
  contact: {
    name: 'Contact form',
    description: 'A big call to action over the short inquiry form.',
    icon: 'mail',
    pages: ['home'],
    group: 'form',
  },
  social: {
    name: 'Social links',
    description: 'The studio’s social accounts.',
    icon: 'globe',
  },
  cta: {
    name: 'Call to action',
    description: 'A heading, a line and a button.',
    icon: 'arrow',
  },
  aboutStory: {
    name: 'Story',
    description: 'A heading with the mission and the vision.',
    icon: 'note',
    group: 'heading',
  },
  statistics: {
    name: 'Numbers',
    description: 'Counters from Numbers, in the look you choose.',
    icon: 'chart',
  },
  team: {
    name: 'Team grid',
    description: 'Every published team member, as cards.',
    icon: 'users',
    once: true,
  },
  certifications: {
    name: 'Certifications',
    description: 'The published certifications.',
    icon: 'shield',
    once: true,
  },
  contactInquiry: {
    name: 'Inquiry form',
    description: 'The full inquiry form of the contact page.',
    icon: 'form',
    pages: ['contact'],
    group: 'form',
  },
  contactChannels: {
    name: 'Direct channels',
    description: 'The email and WhatsApp cards.',
    icon: 'phone',
    pages: ['contact'],
    once: true,
  },
  faq: {
    name: 'FAQ',
    description: 'The questions from Content, FAQ.',
    icon: 'note',
    pages: ['contact'],
    once: true,
  },
  selectedWork: {
    name: 'Selected work',
    description: 'The featured projects, one large and two beside it.',
    icon: 'briefcase',
    pages: ['home'],
    once: true,
  },
  testimonials: {
    name: 'Testimonials',
    description: 'Client quotes from Testimonials, one at a time.',
    icon: 'quote',
    once: true,
  },
  aboutWho: {
    name: 'Who we are',
    description: 'The About page’s opening, with a poster and a clip.',
    icon: 'info',
    pages: ['about'],
    group: 'heading',
  },
  leadership: {
    name: 'Leadership',
    description: 'The leaders from Team, in a slider.',
    icon: 'users',
    once: true,
  },
  workHero: {
    name: 'Project banner',
    description: 'Our Work’s opening banner, on the latest or a pinned project.',
    icon: 'image',
    pages: ['portfolio'],
    once: true,
  },
  proof: {
    name: 'Proof',
    description: 'Numbers and client quotes for Our Work.',
    icon: 'chart',
    pages: ['portfolio'],
    once: true,
  },
  workIntro: {
    name: 'Work intro',
    description: 'A statement with two framed pictures.',
    icon: 'image',
    pages: ['portfolio'],
    once: true,
  },
  projectGrid: {
    name: 'Featured projects',
    description: 'The featured projects, with the filters.',
    icon: 'grid',
    pages: ['portfolio'],
    group: 'projects',
  },
  pageHead: {
    name: 'Page head',
    description: 'The All projects heading, its line and the way back.',
    icon: 'type',
    pages: ['portfolio-all'],
    group: 'heading',
  },
  projectCatalog: {
    name: 'Project catalogue',
    description: 'Every published project, with the filters.',
    icon: 'grid',
    pages: ['portfolio-all'],
    group: 'projects',
  },
  hello: {
    name: 'Say hello',
    description: 'The inquiry form that closes the Services page.',
    icon: 'send',
    pages: ['services'],
    group: 'form',
  },
  serviceExplorer: {
    name: 'Service explorer',
    description: 'One panel per discipline, listing its services.',
    icon: 'list',
    pages: ['services'],
    once: true,
  },
  joinWhy: {
    name: 'Why join',
    description: 'The reasons to join the studio.',
    icon: 'star',
    pages: ['join'],
    once: true,
  },
  joinSteps: {
    name: 'Hiring steps',
    description: 'How applying works, step by step.',
    icon: 'list',
    pages: ['join'],
    once: true,
  },
  joinApply: {
    name: 'Application',
    description: 'The band around the application form.',
    icon: 'form',
    pages: ['join'],
    group: 'form',
  },
  // Admin v2 E10: blocks for any page (no page, no `once`, no group); Galleries and Videos up
  // to MEDIA_BLOCKS_PER_PAGE together (availability below, and the API's own check).
  textBlock: {
    name: 'Text block',
    description: 'A small label, a heading and paragraphs, in both languages.',
    icon: 'type',
  },
  gallery: {
    name: 'Gallery',
    description: 'Up to twelve pictures from the Media library, in a grid.',
    icon: 'image',
  },
  video: {
    name: 'Video',
    description: 'A full width still that plays a moment of a film while it is on screen.',
    icon: 'film',
  },
};

/** The routed page a slug is, or null (a page no route renders: E11 builds those). */
export function routedPage(slug: string): VisibilityPageSlug | null {
  return isVisibilityPageSlug(slug) ? slug : null;
}

const GROUP_WORDS: Readonly<Record<Group, (name: string) => string>> = {
  heading: (name) => `This page already has its main heading, in ${name}.`,
  form: (name) => `This page already has a form, in ${name}. A page holds one.`,
  projects: (name) => `This page already lists the projects, in ${name}.`,
};

function pagesInWords(pages: readonly VisibilityPageSlug[]): string {
  const names = pages.map((page) => PAGE_NAMES[page]);
  const last = names.pop();
  return names.length === 0 ? `the ${last} page` : `the ${names.join(', ')} and ${last} pages`;
}

const MEDIA_TYPES: readonly string[] = MEDIA_BLOCK_TYPES;

export interface Availability {
  type: SectionType;
  /** The page may take one now. */
  ok: boolean;
  /** Why not, in words; null when it may. */
  reason: string | null;
}

/**
 * What "Add section" offers a page that holds `present` (every section, hidden ones included:
 * a hidden heading is still one the page may show again): each type, in SECTION_TYPES' order,
 * with the reason when the page may not take one.
 */
export function availability(slug: string, present: readonly string[]): Availability[] {
  const page = routedPage(slug);
  const has = new Set(present);
  return SECTION_TYPES.map((type): Availability => {
    const kind = SECTION_KINDS[type];
    if (!page) {
      return {
        type,
        ok: false,
        reason: 'No route shows this page yet, so a section added here would show nowhere.',
      };
    }
    if (kind.pages && !kind.pages.includes(page)) {
      return { type, ok: false, reason: `Made for ${pagesInWords(kind.pages)}.` };
    }
    if (kind.once && has.has(type)) {
      return { type, ok: false, reason: 'This page has one already.' };
    }
    if (
      MEDIA_TYPES.includes(type) &&
      present.filter((t) => MEDIA_TYPES.includes(t)).length >= MEDIA_BLOCKS_PER_PAGE
    ) {
      return { type, ok: false, reason: MEDIA_BLOCKS_FULL };
    }
    if (kind.group) {
      const other = SECTION_TYPES.find((t) => SECTION_KINDS[t].group === kind.group && has.has(t));
      if (other) {
        return { type, ok: false, reason: GROUP_WORDS[kind.group](SECTION_KINDS[other].name) };
      }
    }
    return { type, ok: true, reason: null };
  });
}

/**
 * Where a section is anchored on its page (the `id` its component renders, which links such as
 * "Skip to the inquiry" point at), or null when it has none.
 */
export function anchorOf(type: string, page: string, variant: unknown): string | null {
  switch (type) {
    case 'aboutIntro':
      return 'about';
    case 'aboutWho':
      return 'who';
    case 'clientsMarquee':
      return 'clients';
    case 'contact':
      return 'contact';
    case 'contactInquiry':
    case 'hello':
      return 'inquiry';
    case 'joinApply':
      return 'apply';
    case 'faq':
      return 'faq';
    case 'projectGrid':
    case 'projectCatalog':
      return 'projects';
    case 'selectedWork':
      return 'selected-work';
    case 'testimonials':
      return 'testimonials';
    case 'servicesOverview':
      return page === 'services' ? 'categories' : 'services';
    case 'statistics':
      return variant === 'band' ? 'numbers' : null;
    default:
      return null;
  }
}

/** The pages whose first hero wears a preset (withHeroPreset): its copy and its banner. */
const HERO_PRESET_PAGES: readonly string[] = ['contact', 'services', 'join'];
const STAT_LOOKS: readonly unknown[] = ['cards', 'band', 'reach', 'proof', 'services'];

/**
 * Which of a type's built-in looks a section shows (F6's builtInLook, which the server's copy
 * module holds; restated here because that module is the copy itself, which must not ship in
 * the admin bundle). tests/lib/pageEditorLibrary.spec.ts holds the two equal over every type,
 * page, variant and position.
 */
export function lookKey(
  type: string,
  place: { page: string; variant?: unknown; firstOfType: boolean },
): string {
  switch (type) {
    case 'hero':
      return place.firstOfType && HERO_PRESET_PAGES.includes(place.page) ? place.page : 'default';
    case 'servicesOverview':
      return place.page === 'services' ? 'page' : 'home';
    case 'social':
      return place.variant === 'klein' ? 'klein' : 'paper';
    case 'statistics':
      return STAT_LOOKS.includes(place.variant) ? String(place.variant) : 'cards';
    default:
      return 'default';
  }
}

/**
 * A section the page always shows whatever its eye says (the route puts it back: the contact
 * page's inquiry form and the Join page's application, the site's two public forms), with the
 * words the editor says it in; null for every other section.
 */
export function alwaysShown(type: string, page: string): string | null {
  if (type === 'contactInquiry' && page === 'contact') {
    return 'The inquiry form is always on this page: hidden or removed, the page puts it back after the hero.';
  }
  if (type === 'joinApply' && page === 'join') {
    return 'The application band is always on this page: hidden or removed, the page puts it back at the end.';
  }
  return null;
}

/**
 * What the route decides around a section, said plainly (ui.md: "honest notes on route data"),
 * or null. `firstOfType`: the section is the first of its type on the page (hidden ones count),
 * which is the one a preset dresses.
 */
export function routeNote(type: string, page: string, firstOfType: boolean): string | null {
  const always = alwaysShown(type, page);
  if (always) return always;
  if (type === 'hero') {
    if (!firstOfType)
      return 'A second hero shows the home page’s built-in words, never a page’s banner.';
    if (page === 'home') {
      return 'On the home page the logo plate opens before this band. Its button goes to Selected work while a project is featured and that band is shown, otherwise to Our Work.';
    }
    if (page === 'contact') {
      return 'On this page the hero is the contact banner, with its own built-in words. Its button goes to the inquiry form.';
    }
    if (page === 'services') {
      return 'On this page the hero is the services banner, with its own built-in words. Its button opens the discipline cards, and its second link goes to Say hello.';
    }
    if (page === 'join') {
      return 'On this page the hero is the Join banner, with its own built-in words. Its button goes to the application.';
    }
  }
  if (type === 'serviceExplorer' && page === 'services') {
    return 'While the discipline cards are shown, the explorer is shown too: the cards open it.';
  }
  if (type === 'servicesOverview') {
    return page === 'services'
      ? 'On this page each card opens its discipline in the explorer below.'
      : 'Each card links to its discipline on the Services page.';
  }
  if (type === 'faq') return 'The questions show on the Contact page only.';
  if (type === 'workIntro') {
    return 'The link goes to the featured projects below while one is featured, otherwise to All projects.';
  }
  if (type === 'workHero') return 'It shows the latest project unless you pin one.';
  if (type === 'pageHead')
    return 'The number of projects beside the heading is counted by the page.';
  if (type === 'textBlock') {
    return 'It shows only what you write in it, in both languages. Left empty, it shows nothing.';
  }
  if (type === 'gallery') {
    return 'Each picture shows with its alt text from the Media library. With no picture, the section shows nothing.';
  }
  if (type === 'video') {
    return 'Visitors see the still first. The film plays only while the still is on screen, never on phones or tablets, with reduced motion or Save-Data, and it never has sound. With no still, the section shows nothing.';
  }
  return null;
}

/** A screen that holds what a section shows. */
export interface CollectionLink {
  href: string;
  /** "Managed in <title>". */
  title: string;
  /** What is there. */
  sub: string;
}

const CLIENTS: CollectionLink = {
  href: '/admin/clients',
  title: 'Clients',
  sub: 'The names come from the clients marked visible.',
};
const NUMBERS: CollectionLink = {
  href: '/admin/statistics',
  title: 'Numbers',
  sub: 'Each counter, and the pages it shows on.',
};
const QUOTES: CollectionLink = {
  href: '/admin/testimonials',
  title: 'Testimonials',
  sub: 'The quotes, and the pages each one shows on.',
};
const TEAM: CollectionLink = {
  href: '/admin/team',
  title: 'Team',
  sub: 'The people, their roles and their portraits.',
};
const PROJECTS: CollectionLink = {
  href: '/admin/portfolio',
  title: 'Projects',
  sub: 'The projects, which ones are featured, and their order.',
};
const SERVICES: CollectionLink = {
  href: '/admin/services',
  title: 'Services',
  sub: 'The disciplines and the services inside each.',
};
const FORMS: CollectionLink = {
  href: '/admin/forms',
  title: 'Forms',
  sub: 'The form fields are set in Settings, Forms.',
};
const GENERAL: CollectionLink = {
  href: '/admin/settings',
  title: 'General settings',
  sub: 'The studio’s email, WhatsApp and social accounts.',
};
const MEDIA: CollectionLink = {
  href: '/admin/media',
  title: 'Media library',
  sub: 'The pictures, with their alt text in both languages.',
};

/** The screens that hold what a section shows (ui.md "collection link rows"). */
export function collectionLinks(type: string): readonly CollectionLink[] {
  switch (type) {
    case 'clientsMarquee':
      return [CLIENTS];
    case 'servicesOverview':
    case 'serviceExplorer':
      return [SERVICES];
    case 'contact':
    case 'contactInquiry':
    case 'hello':
      return [FORMS];
    case 'statistics':
      return [NUMBERS];
    case 'team':
    case 'leadership':
      return [TEAM];
    case 'certifications':
      return [
        {
          href: '/admin/certifications',
          title: 'Certifications',
          sub: 'Each certification and its issuer.',
        },
      ];
    case 'faq':
      return [
        { href: '/admin/faq', title: 'FAQ', sub: 'The questions and answers, in both languages.' },
      ];
    case 'selectedWork':
    case 'workHero':
    case 'projectGrid':
    case 'projectCatalog':
      return [PROJECTS];
    case 'testimonials':
      return [QUOTES];
    case 'proof':
      return [NUMBERS, QUOTES];
    case 'contactChannels':
    case 'social':
      return [GENERAL];
    case 'joinApply':
      return [
        {
          href: '/admin/settings',
          title: 'General settings',
          sub: 'Whether the Join form takes applications.',
        },
        {
          href: '/admin/applications',
          title: 'Job applications',
          sub: 'What the form has received.',
        },
      ];
    case 'aboutWho':
    case 'workIntro':
    case 'gallery':
    case 'video':
      return [MEDIA];
    default:
      return [];
  }
}

/** Every screen a section's link rows may name (the server keeps those the role opens). */
export function collectionScreens(): string[] {
  return [
    ...new Set(SECTION_TYPES.flatMap((type) => collectionLinks(type).map((link) => link.href))),
  ].sort();
}

/** A link row as the fields column draws it: a link only when the role opens that screen. */
export interface LinkRow extends CollectionLink {
  open: boolean;
}

/**
 * The link rows of a section for a role: `opens` are the screens its menu reaches (the server's
 * PageEditorAccess.opens). A screen the role cannot open (a Content Creator's General settings,
 * Forms or Job applications, which answer it 403) is still named, without a link.
 */
export function linkRows(type: string, opens: readonly string[]): LinkRow[] {
  return collectionLinks(type).map((link) => ({ ...link, open: opens.includes(link.href) }));
}

/** A section's name in the editor: its own label, else its type's name. */
export function sectionName(section: { type: string; label?: unknown }): string {
  if (typeof section.label === 'string' && section.label.trim() !== '') return section.label.trim();
  return kindOf(section.type)?.name ?? section.type;
}

/** The type's entry, or null for a type the library does not know (an old row). */
export function kindOf(type: string): SectionKind | null {
  return (SECTION_TYPES as readonly string[]).includes(type)
    ? SECTION_KINDS[type as SectionType]
    : null;
}
