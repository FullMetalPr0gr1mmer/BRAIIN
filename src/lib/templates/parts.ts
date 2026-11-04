import type { ProjectCopyKey, ServiceCopyKey, TemplateKind } from '@schemas/templateCopyKeys';

// The fixed parts of the two template pages (Admin v2 E3), in the order the page shows them:
// what the template editor lists, read only, in its parts column, and the `data-pv-section`
// value each part carries in a releases preview (and only there), so the editor's preview can
// move to a part picked in that list. Client-safe and Zod-free: the island imports it, and so
// do ServicePage.astro and CaseStudyPage.astro.
//
// `copy` names the shared text keys each part shows, in the page's order: the editor draws the
// Shared text form as one card per part (tests/lib/templateParts.spec.ts holds every catalogue
// key to exactly one part). `own` says, in words, what of the item's own content the part shows.
// A part with no marker (`id: null`) is not one block of the page (the floating button).

export interface TemplatePart<K extends string = string> {
  key: string;
  /** The `data-pv-section` value in a preview, or null for a part with no block of its own. */
  id: string | null;
  name: string;
  /** What of the service's or project's own content the part shows. */
  own: string;
  /** The shared text keys it shows. */
  copy: readonly K[];
}

export const SERVICE_PARTS = [
  {
    key: 'hero',
    id: 'tpl-hero',
    name: 'Hero',
    own: 'The service name, its tagline, the poster and the hero clip.',
    copy: ['services', 'home', 'skipKicker', 'skip', 'seeCase'],
  },
  {
    key: 'what',
    id: 'tpl-what',
    name: 'The service',
    own: 'The intro statement, the explanation and the deliverables.',
    copy: ['whatTag', 'get'],
  },
  {
    key: 'value',
    id: 'tpl-value',
    name: 'The value we add',
    own: 'The value cards.',
    copy: ['valueTag', 'valueHeading', 'valueHeadingAccent', 'valueLead'],
  },
  {
    key: 'case',
    id: 'tpl-case',
    name: 'Case study',
    own: 'The service’s case study, shown when it has one.',
    copy: ['caseTag', 'seeProject', 'context', 'problem', 'did'],
  },
  {
    key: 'hello',
    id: 'tpl-hello',
    name: 'Say hello',
    own: 'The inquiry form, with this service chosen.',
    copy: ['helloLeadIn', 'helloLead'],
  },
  {
    key: 'more',
    id: 'tpl-more',
    name: 'More in the discipline',
    own: 'The other services of its discipline.',
    copy: ['moreTag', 'moreLeadIn', 'all'],
  },
  {
    key: 'fab',
    id: null,
    name: 'Skip to inquiry button',
    own: 'The floating button on phones.',
    copy: ['fab'],
  },
] as const satisfies readonly TemplatePart<ServiceCopyKey>[];

export const PROJECT_PARTS = [
  {
    key: 'banner',
    id: 'tpl-banner',
    name: 'Banner',
    own: 'The hero frame and its clip, else the card poster.',
    copy: ['bannerTag'],
  },
  {
    key: 'title',
    id: 'tpl-title',
    name: 'Title',
    own: 'The project name, its keywords, sector, client and year.',
    copy: ['back', 'keywords'],
  },
  {
    key: 'overview',
    id: 'tpl-overview',
    name: 'Overview',
    own: 'The overview, the scope, the goal, the result and the final film.',
    copy: ['overview', 'scope', 'goal', 'result', 'final'],
  },
  {
    key: 'quote',
    id: 'tpl-quote',
    name: 'Quote',
    own: 'The project’s testimonial, shown when it has one.',
    copy: [],
  },
  {
    key: 'breakdown',
    id: 'tpl-breakdown',
    name: 'Breakdown',
    own: 'The sketches, behind the scenes and process stills.',
    copy: [
      'breakdownTag',
      'breakdownHeading',
      'breakdownHeadingAccent',
      'breakdownLead',
      'sketch',
      'bts',
      'process',
    ],
  },
  {
    key: 'gallery',
    id: 'tpl-gallery',
    name: 'Gallery',
    own: 'The gallery stills, which open in the image viewer.',
    copy: ['galleryTag', 'galleryHeading', 'galleryHeadingAccent'],
  },
  {
    key: 'viewer',
    id: null,
    name: 'Image viewer',
    own: 'A still opened full size.',
    copy: ['viewer', 'viewerClose', 'viewerPrevious', 'viewerNext'],
  },
  {
    key: 'next',
    id: 'tpl-next',
    name: 'Next project',
    own: 'The next project’s card.',
    copy: ['nextProject'],
  },
  {
    key: 'cta',
    id: 'tpl-cta',
    name: 'Start a project',
    own: 'The site’s lead band, as on every page.',
    copy: [],
  },
] as const satisfies readonly TemplatePart<ProjectCopyKey>[];

export const TEMPLATE_PARTS: Readonly<Record<TemplateKind, readonly TemplatePart[]>> = {
  service: SERVICE_PARTS,
  project: PROJECT_PARTS,
};

type PartIds<P extends readonly { key: string; id: string | null }[]> = {
  [Part in P[number] as Part['id'] extends string ? Part['key'] : never]: string;
};

function idsOf<P extends readonly { key: string; id: string | null }[]>(parts: P): PartIds<P> {
  const out: Record<string, string> = {};
  for (const part of parts) if (part.id !== null) out[part.key] = part.id;
  return out as PartIds<P>;
}

/** Each marked part's `data-pv-section` value, by its key (the pages' markers). */
export const TEMPLATE_PART_IDS = {
  service: idsOf(SERVICE_PARTS),
  project: idsOf(PROJECT_PARTS),
};
