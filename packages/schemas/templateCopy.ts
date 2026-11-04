import { z } from 'zod';
import { StrictAccentSchema } from './media';

// The template pages' shared text (Admin v2 E3): the words every service page and every
// project (case study) page shows around the item's own content, stored in
// `public.template_copy` (the E3 migration) as DIFFERENCES from the built-in words, one row per
// tenant: `service` (the service page template) and `project` (the case study template). An
// absent key means "as built"; an empty object, the whole template as built. The built-in
// words are the code's (src/lib/services/pageCopy.ts SERVICE_PAGE_COPY and
// src/lib/portfolio/pageCopy.ts CASE_PAGE_COPY), so a site with no row renders the bytes it
// always did.
//
// The key sets are CLOSED: an editor rewords the words the templates have, never adds one. A
// text key is a bilingual line, Arabic required like English; plain text (no `<` or `>`, no
// line break and no C0/C1 control character), trimmed, at most its cap. An accented heading
// has a sibling key, `<heading>Accent`: which of its words carry the colour, a word range per
// language (F5b's AccentSchema, never markup). The SQL CHECK `app.template_copy_ok` holds the
// same keys and shapes (tests/lib/templateCopySql.spec.ts holds the two lists equal).

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

/** The characters no shared text may carry: markup brackets and C0/C1 controls (line breaks too). */
export const TEMPLATE_COPY_FORBIDDEN = /[<>\u0000-\u001F\u007F-\u009F]/;

const copyHalf = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((v) => !TEMPLATE_COPY_FORBIDDEN.test(v), {
      message: 'plain text only: no < or >, no line break',
    });

/** One bilingual line a visitor reads; Arabic is required like English. */
export const templateCopyLine = (max: number) =>
  z.object({ en: copyHalf(max), ar: copyHalf(max) }).strict();

function mapSchema(kind: TemplateKind) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, def] of Object.entries(TEMPLATE_COPY_KEYS[kind]) as [
    string,
    TemplateCopyKey,
  ][]) {
    shape[key] = (def.kind === 'text' ? templateCopyLine(def.max) : StrictAccentSchema).optional();
  }
  return z.object(shape).strict();
}

/** The service page template's stored differences. */
export const ServiceTemplateCopySchema = mapSchema('service');
/** The project page template's stored differences. */
export const ProjectTemplateCopySchema = mapSchema('project');

/** A save of the shared text: either template's map (whole: it replaces the stored one). */
export const TemplateCopyWriteSchema = z
  .object({
    service: ServiceTemplateCopySchema.optional(),
    project: ProjectTemplateCopySchema.optional(),
    version: z.number().int().min(0),
  })
  .strict();
export type TemplateCopyWrite = z.infer<typeof TemplateCopyWriteSchema>;

/** One key's schema on its own, so a reader keeps every valid key of a row that has a bad one. */
export function templateCopyKeySchema(def: TemplateCopyKey): z.ZodTypeAny {
  return def.kind === 'text' ? templateCopyLine(def.max) : StrictAccentSchema;
}
