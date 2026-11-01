import { z } from 'zod';
import { BUDGET_BANDS } from './lead';

// The forms config (Admin v2 E8): what an editor may change about the site's two public
// forms, stored as DIFFERENCES from the built-in forms in `public.form_settings` (0117), one
// row per tenant: `inquiry` (the lead form on the home page, Contact and the services pages)
// and `application` (the Join form). An absent key means "as built"; an empty object, the
// whole form as built.
//
// The field sets are CLOSED (docs/admin-v2/deviations.md, "Forms"): an editor relabels,
// reorders, hides or requires the fields the code has, never adds one. Only an OPTIONAL field
// may be hidden or made required; a field the pipeline needs (a lead's name, e-mail and
// message; everything ApplicationInputSchema requires) has a label and nothing else, so the
// schemas below cannot even express hiding it. The public endpoints read the published row and
// hold a submission to it, with LeadInputSchema and ApplicationInputSchema as the floor
// (src/lib/forms/config.ts).
//
// Copy is plain text: no `<` or `>` (no markup, rendered as text anyway), no line break and no
// C0/C1 control character, trimmed, English and Arabic both required (the SQL CHECK
// `app.form_copy_ok` holds the first three on every string in the row).

/** The characters no form copy may carry: markup brackets and C0/C1 controls (line breaks too). */
export const FORM_COPY_FORBIDDEN = /[<>\u0000-\u001F\u007F-\u009F]/;

/** Each text's longest form, in characters. */
export const FORM_COPY_MAX = {
  label: 80,
  button: 40,
  budget: 60,
  consentApplication: 400,
  consentFutureRoles: 200,
} as const;

const copyHalf = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((v) => !FORM_COPY_FORBIDDEN.test(v), {
      message: 'plain text only: no < or >, no line break',
    });

/** One bilingual line a visitor reads; Arabic is required like English. */
const formCopy = (max: number) => z.object({ en: copyHalf(max), ar: copyHalf(max) }).strict();

// ---- the inquiry form ----------------------------------------------------------------------

/**
 * The inquiry form's fields, in the order the pages render them as built: every variant's
 * fields (src/lib/forms/contactPayload.ts CONTACT_FORM_FIELDS) in one list that keeps each
 * variant's order (tests/lib/formsConfig.spec.ts holds the two equal).
 */
export const INQUIRY_FIELDS = [
  'name',
  'email',
  'company',
  'phone',
  'service',
  'budget',
  'deadline',
  'message',
] as const;
export type InquiryField = (typeof INQUIRY_FIELDS)[number];

/** The fields an editor may hide or require. Name, e-mail and message stay required. */
export const INQUIRY_OPTIONAL_FIELDS = [
  'company',
  'phone',
  'service',
  'budget',
  'deadline',
] as const satisfies readonly InquiryField[];
export type InquiryOptionalField = (typeof INQUIRY_OPTIONAL_FIELDS)[number];

// ---- the Join form -------------------------------------------------------------------------

/**
 * The Join form's groups and their controls as built (src/components/ApplicationForm.astro):
 * an editor may reorder the controls inside a group, never move one to another group (each
 * group is a fieldset whose title is the page's content).
 */
export const APPLICATION_GROUPS = {
  about: ['name', 'email', 'phone', 'city'],
  role: ['role', 'experience', 'workType', 'availability', 'skills'],
  work: ['portfolio', 'linkedin', 'cv', 'message'],
} as const;
export type ApplicationGroup = keyof typeof APPLICATION_GROUPS;
export const APPLICATION_GROUP_IDS = [
  'about',
  'role',
  'work',
] as const satisfies readonly ApplicationGroup[];

export const APPLICATION_FIELDS = [
  ...APPLICATION_GROUPS.about,
  ...APPLICATION_GROUPS.role,
  ...APPLICATION_GROUPS.work,
] as const;
export type ApplicationField = (typeof APPLICATION_FIELDS)[number];

/** The controls an editor may hide or require: what ApplicationInputSchema leaves optional. */
export const APPLICATION_OPTIONAL_FIELDS = [
  'skills',
  'linkedin',
  'cv',
] as const satisfies readonly ApplicationField[];
export type ApplicationOptionalField = (typeof APPLICATION_OPTIONAL_FIELDS)[number];

// ---- the overrides -------------------------------------------------------------------------

/** A field the pipeline needs: its label only. */
const FixedFieldSchema = z.object({ label: formCopy(FORM_COPY_MAX.label).optional() }).strict();

/** An optional field: its label, and whether the form shows it and requires it. */
const OptionalFieldSchema = z
  .object({
    label: formCopy(FORM_COPY_MAX.label).optional(),
    visible: z.boolean().optional(),
    required: z.boolean().optional(),
  })
  .strict()
  .refine((f) => !(f.visible === false && f.required === true), {
    message: 'a hidden field cannot be required',
    path: ['required'],
  });

const fieldsShape = <F extends string>(
  all: readonly F[],
  optional: readonly string[],
): Record<F, z.ZodTypeAny> =>
  Object.fromEntries(
    all.map((key) => [
      key,
      (optional.includes(key) ? OptionalFieldSchema : FixedFieldSchema).optional(),
    ]),
  ) as unknown as Record<F, z.ZodTypeAny>;

/** A reordering: every one of `all`, each once. */
const orderOf = <F extends string>(all: readonly [F, ...F[]]) =>
  z
    .array(z.enum(all))
    .length(all.length)
    .refine((list) => new Set(list).size === list.length, { message: 'each field once' });

export const InquiryFieldsSchema = z
  .object(fieldsShape(INQUIRY_FIELDS, INQUIRY_OPTIONAL_FIELDS))
  .strict();
export const InquiryOrderSchema = orderOf(INQUIRY_FIELDS);
export const FormButtonSchema = formCopy(FORM_COPY_MAX.button);
export const BudgetLabelSchema = formCopy(FORM_COPY_MAX.budget);
export const BudgetLabelsSchema = z
  .object(
    Object.fromEntries(
      BUDGET_BANDS.map((band) => [band, BudgetLabelSchema.optional()]),
    ) as unknown as Record<(typeof BUDGET_BANDS)[number], z.ZodTypeAny>,
  )
  .strict();

/** `form_settings.inquiry`: the inquiry form's differences from the built-in form. */
export const InquiryConfigSchema = z
  .object({
    fields: InquiryFieldsSchema.optional(),
    order: InquiryOrderSchema.optional(),
    button: FormButtonSchema.optional(),
    budgets: BudgetLabelsSchema.optional(),
  })
  .strict();
export type InquiryConfig = z.infer<typeof InquiryConfigSchema>;

export const ApplicationFieldsSchema = z
  .object(fieldsShape(APPLICATION_FIELDS, APPLICATION_OPTIONAL_FIELDS))
  .strict();
export const ApplicationOrderSchema = z
  .object({
    about: orderOf(APPLICATION_GROUPS.about).optional(),
    role: orderOf(APPLICATION_GROUPS.role).optional(),
    work: orderOf(APPLICATION_GROUPS.work).optional(),
  })
  .strict();
export const ConsentCopySchema = z
  .object({
    application: formCopy(FORM_COPY_MAX.consentApplication).optional(),
    futureRoles: formCopy(FORM_COPY_MAX.consentFutureRoles).optional(),
  })
  .strict();

/** `form_settings.application`: the Join form's differences from the built-in form. */
export const ApplicationConfigSchema = z
  .object({
    fields: ApplicationFieldsSchema.optional(),
    order: ApplicationOrderSchema.optional(),
    button: FormButtonSchema.optional(),
    consent: ConsentCopySchema.optional(),
  })
  .strict();
export type ApplicationConfig = z.infer<typeof ApplicationConfigSchema>;

/** One field's override, as both forms store it (the fixed fields use `label` only). */
export interface FieldOverride {
  label?: { en: string; ar: string } | undefined;
  visible?: boolean | undefined;
  required?: boolean | undefined;
}

/**
 * The admin's save (PATCH /api/admin/form-settings): either form, or both, with the version
 * the editor loaded (0 = no row yet). A form left out is kept as stored.
 */
export const FormSettingsWriteSchema = z
  .object({
    inquiry: InquiryConfigSchema.optional(),
    application: ApplicationConfigSchema.optional(),
    version: z.number().int().min(0),
  })
  .strict();
export type FormSettingsWrite = z.infer<typeof FormSettingsWriteSchema>;

/** The largest a stored form may be (the SQL CHECK's bound): far above any valid config. */
export const FORM_CONFIG_MAX_BYTES = 16_384;

// ---- the consent version -------------------------------------------------------------------

/**
 * The Join form's consent version as posted and stored: the recruitment notice's date
 * (packages/consent/recruitment.ts), plus `.r<N>` when the consent lines were reworded in
 * the forms config (N = `form_settings.consent_revision` when the form was rendered). The SQL
 * CHECK on `job_applications.consent_version` holds the same pattern (0117).
 */
export const CONSENT_VERSION_PATTERN = /^(\d{4}-\d{2}-\d{2})(?:\.r([1-9]\d{0,8}))?$/;
