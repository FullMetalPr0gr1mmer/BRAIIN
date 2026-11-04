// The template pages' shared text catalogue (Admin v2 E3): which keys each template has and
// their caps. Zod-free, so the template editor's island draws its fields from it without zod
// in its bundle; packages/schemas/templateCopy.ts builds the schemas on it, and the SQL CHECK
// `app.template_copy_ok` holds the same keys (tests/lib/templateCopySql.spec.ts).

export const TEMPLATE_KINDS = ['service', 'project'] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

/** A text key's longest form, in characters (each at most TEMPLATE_COPY_TEXT_MAX). */
export interface TextKey {
  kind: 'text';
  max: number;
}
/** An accent key: the text key whose words it highlights. */
export interface AccentKey {
  kind: 'accent';
  of: string;
}
export type TemplateCopyKey = TextKey | AccentKey;

const text = (max: number): TextKey => ({ kind: 'text', max });
const accent = (of: string): AccentKey => ({ kind: 'accent', of });

/** The longest any text key may be: the SQL CHECK's bound. */
export const TEMPLATE_COPY_TEXT_MAX = 300;

/** The largest a stored template may be (the SQL CHECK's bound): far above any valid map. */
export const TEMPLATE_COPY_MAX_BYTES = 16_384;

/**
 * Every key of each template, in the order the page shows its words. "Confidential client" is
 * not one: the Our Work cards, the case study's facets and the service page's case block share
 * that wording (FacetTags), so it stays the code's until it can change everywhere at once.
 */
export const TEMPLATE_COPY_KEYS = {
  service: {
    services: text(40),
    home: text(40),
    skipKicker: text(40),
    skip: text(40),
    seeCase: text(40),
    whatTag: text(40),
    get: text(60),
    valueTag: text(40),
    valueHeading: text(80),
    valueHeadingAccent: accent('valueHeading'),
    valueLead: text(200),
    caseTag: text(40),
    seeProject: text(40),
    context: text(40),
    problem: text(40),
    did: text(40),
    helloLeadIn: text(40),
    helloLead: text(300),
    moreTag: text(60),
    moreLeadIn: text(40),
    all: text(40),
    fab: text(40),
  },
  project: {
    bannerTag: text(40),
    back: text(40),
    keywords: text(40),
    overview: text(40),
    scope: text(40),
    goal: text(40),
    result: text(40),
    final: text(40),
    breakdownTag: text(40),
    breakdownHeading: text(80),
    breakdownHeadingAccent: accent('breakdownHeading'),
    breakdownLead: text(200),
    sketch: text(40),
    bts: text(40),
    process: text(40),
    galleryTag: text(40),
    galleryHeading: text(80),
    galleryHeadingAccent: accent('galleryHeading'),
    viewer: text(40),
    viewerClose: text(40),
    viewerPrevious: text(40),
    viewerNext: text(40),
    nextProject: text(40),
  },
} as const satisfies Record<TemplateKind, Record<string, TemplateCopyKey>>;

export type ServiceCopyKey = keyof (typeof TEMPLATE_COPY_KEYS)['service'];
export type ProjectCopyKey = keyof (typeof TEMPLATE_COPY_KEYS)['project'];
