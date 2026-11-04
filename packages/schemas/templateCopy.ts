import { z } from 'zod';
import { StrictAccentSchema } from './media';
import { TEMPLATE_COPY_KEYS, type TemplateCopyKey, type TemplateKind } from './templateCopyKeys';

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

export {
  TEMPLATE_COPY_KEYS,
  TEMPLATE_COPY_MAX_BYTES,
  TEMPLATE_COPY_TEXT_MAX,
  TEMPLATE_KINDS,
  type AccentKey,
  type ProjectCopyKey,
  type ServiceCopyKey,
  type TemplateCopyKey,
  type TemplateKind,
  type TextKey,
} from './templateCopyKeys';

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
