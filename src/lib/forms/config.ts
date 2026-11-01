import type { z } from 'zod';
import {
  APPLICATION_FIELDS,
  APPLICATION_GROUP_IDS,
  APPLICATION_GROUPS,
  APPLICATION_OPTIONAL_FIELDS,
  ApplicationConfigSchema,
  ApplicationFieldsSchema,
  ApplicationOrderSchema,
  BudgetLabelSchema,
  CONSENT_VERSION_PATTERN,
  ConsentCopySchema,
  FormButtonSchema,
  INQUIRY_FIELDS,
  INQUIRY_OPTIONAL_FIELDS,
  InquiryConfigSchema,
  InquiryFieldsSchema,
  InquiryOrderSchema,
  type ApplicationConfig,
  type ApplicationField,
  type ApplicationGroup,
  type ApplicationOptionalField,
  type FieldOverride,
  type InquiryConfig,
  type InquiryField,
  type InquiryOptionalField,
} from '@schemas/forms';
import { BUDGET_BANDS, BUDGET_BAND_LABELS, type LeadInput } from '@schemas/lead';
import type { ApplicationInput } from '@schemas/application';
import type { Locale } from '@schemas/primitives';
import { RECRUITMENT_CONSENT, RECRUITMENT_POLICY_VERSION } from '@consent/recruitment';
import { CONTACT_FORM_COPY } from './contactCopy';
import { APPLY_FORM_COPY } from './applicationCopy';
import { CONTACT_FORM_FIELDS, type ContactFormVariant } from './contactPayload';

// The forms config, resolved (Admin v2 E8). The published `form_settings` row holds only what
// differs from the built-in forms (packages/schemas/forms.ts); this module lays it over the
// code's forms and answers the two questions everything else asks:
//   - what a form renders (ContactForm.astro, ApplicationForm.astro, the admin's preview of a
//     label): its fields in order, each with its label and whether it is required, the button,
//     the budget labels and the consent lines;
//   - what a submission may carry (/api/contact, /api/apply): a field the form does not show is
//     dropped, a field the config requires is refused when empty. The Zod input schemas stay
//     the floor: nothing here loosens what they require.
//
// The row is UNTRUSTED (a staff token can write it around the Worker while releases are off,
// and the CHECK holds only its copy's characters): `readInquiryConfig` and
// `readApplicationConfig` keep each part that parses and drop each part that does not, so a
// bad value costs that part its built-in value, never the page or the endpoint.

type Bilingual = { en: string; ar: string };

// ---- reading the untrusted row -------------------------------------------------------------

/** The parts of `raw` (an object) that `schema` accepts one by one; the rest are dropped. */
function keepParsed(
  raw: unknown,
  parts: Readonly<Record<string, z.ZodTypeAny>>,
): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(parts)) {
    const value = (raw as Record<string, unknown>)[key];
    if (value === undefined) continue;
    const parsed = schema.safeParse(value);
    if (parsed.success) out[key] = parsed.data;
  }
  return out;
}

/** A map of `key → override` kept entry by entry (one bad field drops that field only). */
function keepEntries(raw: unknown, schema: z.ZodObject<z.ZodRawShape>): Record<string, unknown> {
  return keepParsed(raw, schema.shape as Record<string, z.ZodTypeAny>);
}

/** The inquiry form's stored overrides, each part that parses. */
export function readInquiryConfig(raw: unknown): InquiryConfig {
  const whole = InquiryConfigSchema.safeParse(raw);
  if (whole.success) return whole.data;
  const top = keepParsed(raw, { order: InquiryOrderSchema, button: FormButtonSchema });
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const fields = keepEntries(source['fields'], InquiryFieldsSchema);
  const budgets = keepParsed(
    source['budgets'],
    Object.fromEntries(BUDGET_BANDS.map((band) => [band, BudgetLabelSchema])),
  );
  return {
    ...top,
    ...(Object.keys(fields).length > 0 ? { fields } : {}),
    ...(Object.keys(budgets).length > 0 ? { budgets } : {}),
  } as InquiryConfig;
}

/** The Join form's stored overrides, each part that parses. */
export function readApplicationConfig(raw: unknown): ApplicationConfig {
  const whole = ApplicationConfigSchema.safeParse(raw);
  if (whole.success) return whole.data;
  const top = keepParsed(raw, { button: FormButtonSchema });
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const fields = keepEntries(source['fields'], ApplicationFieldsSchema);
  const order = keepEntries(source['order'], ApplicationOrderSchema);
  const consent = keepEntries(source['consent'], ConsentCopySchema);
  return {
    ...top,
    ...(Object.keys(fields).length > 0 ? { fields } : {}),
    ...(Object.keys(order).length > 0 ? { order } : {}),
    ...(Object.keys(consent).length > 0 ? { consent } : {}),
  } as ApplicationConfig;
}

/** The published config as every reader holds it. */
export interface FormSettings {
  inquiry: InquiryConfig;
  application: ApplicationConfig;
  /** `form_settings.consent_revision`: 0 until the Join consent lines are first reworded. */
  consentRevision: number;
}

/** No row, or no readable row: every form as built. */
export const BUILT_IN_FORMS: FormSettings = Object.freeze({
  inquiry: {},
  application: {},
  consentRevision: 0,
});

/**
 * What every reader of the published config selects: the copy and the consent revision. anon's
 * column grant (the E8 migration) has four columns, `tenant_id` too, which a reader needs only
 * as its filter. The public renderer (src/lib/data/forms.ts) and the two endpoints
 * (./published.ts) both select this.
 */
export const FORM_SETTINGS_PUBLIC_COLUMNS = 'inquiry,application,consent_revision';

/** A `form_settings` row (FORM_SETTINGS_PUBLIC_COLUMNS) → the config every reader uses. */
export function formSettingsFromRow(row: unknown): FormSettings {
  if (!row || typeof row !== 'object') return BUILT_IN_FORMS;
  const r = row as Record<string, unknown>;
  const revision = r['consent_revision'];
  return {
    inquiry: readInquiryConfig(r['inquiry']),
    application: readApplicationConfig(r['application']),
    consentRevision:
      typeof revision === 'number' && Number.isInteger(revision) && revision >= 0 ? revision : 0,
  };
}

// ---- the inquiry form ----------------------------------------------------------------------

/** The built-in label of each inquiry field (the words ContactForm renders). */
export const INQUIRY_LABELS: Readonly<Record<InquiryField, Bilingual>> = Object.fromEntries(
  INQUIRY_FIELDS.map((field) => [
    field,
    { en: CONTACT_FORM_COPY.en[field], ar: CONTACT_FORM_COPY.ar[field] },
  ]),
) as Record<InquiryField, Bilingual>;

const isInquiryOptional = (field: InquiryField): field is InquiryOptionalField =>
  (INQUIRY_OPTIONAL_FIELDS as readonly string[]).includes(field);

const overrideOf = (
  fields: Readonly<Record<string, unknown>> | undefined,
  key: string,
): FieldOverride => (fields?.[key] as FieldOverride | undefined) ?? {};

/** One inquiry field as a form renders it. */
export interface InquiryFieldView {
  field: InquiryField;
  label: string;
  required: boolean;
}

/** The inquiry form as a variant renders it in a locale. */
export interface InquiryView {
  fields: InquiryFieldView[];
  /** The config's button text, or null for the variant's built-in one. */
  button: string | null;
  /** Each budget band's label. */
  budgets: Record<(typeof BUDGET_BANDS)[number], string>;
  /** The optional fields this form shows as required: what it posts as its claim (CR1). */
  requiredOptional: InquiryOptionalField[];
}

/** The fields in the config's order (each once; a stored order is a whole permutation). */
export function inquiryOrder(config: InquiryConfig): InquiryField[] {
  return [...(config.order ?? INQUIRY_FIELDS)];
}

/** Whether the config hides an optional field (only optional fields can be hidden). */
export function inquiryHidden(config: InquiryConfig, field: InquiryField): boolean {
  return isInquiryOptional(field) && overrideOf(config.fields, field).visible === false;
}

/** Whether a field is required: the pipeline's three always, an optional one by the config. */
export function inquiryRequired(config: InquiryConfig, field: InquiryField): boolean {
  if (!isInquiryOptional(field)) return true;
  const o = overrideOf(config.fields, field);
  return o.visible !== false && o.required === true;
}

/** What a variant asks: its own fields, less the hidden ones, in the config's order. */
export function inquiryFieldsFor(
  config: InquiryConfig,
  variant: ContactFormVariant,
): InquiryField[] {
  const own = CONTACT_FORM_FIELDS[variant] as readonly string[];
  return inquiryOrder(config).filter((f) => own.includes(f) && !inquiryHidden(config, f));
}

export function inquiryView(
  config: InquiryConfig,
  variant: ContactFormVariant,
  locale: Locale,
): InquiryView {
  const asked = inquiryFieldsFor(config, variant);
  return {
    fields: asked.map((field) => ({
      field,
      label: overrideOf(config.fields, field).label?.[locale] ?? INQUIRY_LABELS[field][locale],
      required: inquiryRequired(config, field),
    })),
    requiredOptional: asked.filter(
      (field): field is InquiryOptionalField =>
        isInquiryOptional(field) && inquiryRequired(config, field),
    ),
    button: config.button?.[locale] ?? null,
    budgets: Object.fromEntries(
      BUDGET_BANDS.map((band) => [
        band,
        (config.budgets as Record<string, Bilingual | undefined> | undefined)?.[band]?.[locale] ??
          BUDGET_BAND_LABELS[band][locale],
      ]),
    ) as InquiryView['budgets'],
  };
}

/** The lead keys each optional inquiry field can post under. */
const INQUIRY_LEAD_KEYS: Readonly<Record<InquiryOptionalField, readonly (keyof LeadInput)[]>> = {
  company: ['company'],
  phone: ['phone'],
  service: ['serviceOfInterest', 'disciplineOfInterest'],
  budget: ['budgetBand'],
  // The legacy band (pages cached before the free-text deadline) is the same question.
  deadline: ['timelineText', 'timelineBand'],
};

const VARIANTS = Object.keys(CONTACT_FORM_FIELDS) as ContactFormVariant[];

export type InquiryCheck = { ok: true; data: LeadInput } | { ok: false; fields: string[] };

/** Whether a send must answer `field`: the config requires it and the page showed it so. */
const claimRequires = (claim: readonly string[] | undefined, field: string): boolean =>
  claim === undefined || claim.includes(field);

/**
 * A parsed lead held to the published config. `variant` is the form the visitor sent
 * (`form`); without one, what every variant asks. Every variant is public, so the least any
 * of them asks is the floor anyone can meet: the claim is safe to take, and it never lets a
 * submission keep a field its own form does not show.
 *   - a field the variant does not ask, or the config hides, is DROPPED (data minimisation:
 *     the site said it does not collect it), never refused, so a page rendered before the
 *     change still sends;
 *   - a field the config requires and the variant asks is refused when empty (422 with the
 *     lead key: `serviceOfInterest` for the service), unless the sending page did not show it
 *     as required (`claim`, ./requiredClaim.ts: a page rendered before the config required
 *     it); with no claim, the config decides alone.
 */
export function checkInquiry(
  input: LeadInput,
  config: InquiryConfig,
  variant: ContactFormVariant | undefined,
  claim?: readonly string[],
): InquiryCheck {
  const asked = (field: InquiryField): boolean =>
    variant
      ? inquiryFieldsFor(config, variant).includes(field)
      : VARIANTS.some((v) => inquiryFieldsFor(config, v).includes(field));
  const askedByAll = (field: InquiryField): boolean =>
    variant
      ? inquiryFieldsFor(config, variant).includes(field)
      : VARIANTS.every((v) => inquiryFieldsFor(config, v).includes(field));

  const data: Record<string, unknown> = { ...input };
  // The claim is how the page was drawn, not part of the lead.
  delete data['requiredFields'];
  const missing: string[] = [];
  for (const field of INQUIRY_OPTIONAL_FIELDS) {
    const keys = INQUIRY_LEAD_KEYS[field];
    if (!asked(field)) {
      for (const key of keys) delete data[key];
      continue;
    }
    if (inquiryRequired(config, field) && askedByAll(field) && claimRequires(claim, field)) {
      const given = keys.some((key) => {
        const v = data[key];
        return typeof v === 'string' ? v.trim() !== '' : v !== undefined && v !== null;
      });
      if (!given) missing.push(keys[0]!);
    }
  }
  return missing.length > 0
    ? { ok: false, fields: missing }
    : { ok: true, data: data as LeadInput };
}

// ---- the Join form -------------------------------------------------------------------------

/** The built-in label of each Join control (the words ApplicationForm renders). */
const applicationLabel = (field: ApplicationField, locale: Locale): string => {
  const copy = APPLY_FORM_COPY[locale];
  return field === 'cv' ? copy.cvTitle : copy[field];
};
export const APPLICATION_LABELS: Readonly<Record<ApplicationField, Bilingual>> = Object.fromEntries(
  APPLICATION_FIELDS.map((field) => [
    field,
    { en: applicationLabel(field, 'en'), ar: applicationLabel(field, 'ar') },
  ]),
) as Record<ApplicationField, Bilingual>;

const isApplicationOptional = (field: ApplicationField): field is ApplicationOptionalField =>
  (APPLICATION_OPTIONAL_FIELDS as readonly string[]).includes(field);

export function applicationHidden(config: ApplicationConfig, field: ApplicationField): boolean {
  return isApplicationOptional(field) && overrideOf(config.fields, field).visible === false;
}

/** Required: what the schema requires always; an optional control by the config. */
export function applicationRequired(config: ApplicationConfig, field: ApplicationField): boolean {
  if (!isApplicationOptional(field)) return true;
  const o = overrideOf(config.fields, field);
  return o.visible !== false && o.required === true;
}

/** A group's controls in the config's order, less the hidden ones. */
export function applicationGroupFields(
  config: ApplicationConfig,
  group: ApplicationGroup,
): ApplicationField[] {
  const order =
    (config.order?.[group] as readonly ApplicationField[] | undefined) ??
    (APPLICATION_GROUPS[group] as readonly ApplicationField[]);
  return order.filter((field) => !applicationHidden(config, field));
}

export interface ApplicationFieldView {
  field: ApplicationField;
  label: string;
  required: boolean;
}

export interface ApplicationView {
  groups: Record<ApplicationGroup, ApplicationFieldView[]>;
  button: string | null;
  /** The consent lines, `{brand}` not yet filled (recruitmentConsent fills it). */
  consent: { application: string; futureRoles: string };
  /** What the form posts as `policy_version`, and the application stores. */
  policyVersion: string;
  /** The optional controls this form shows as required: what it posts as its claim (CR1). */
  requiredOptional: ApplicationOptionalField[];
}

/** Whether the config rewords either consent line. */
export function consentReworded(config: ApplicationConfig): boolean {
  return Boolean(config.consent?.application || config.consent?.futureRoles);
}

/**
 * The consent version a form shows: the notice's date, plus the revision of the reworded
 * lines when the config rewords them (CONSENT_VERSION_PATTERN). A reworded config read with
 * revision 0 cannot happen through the database (the trigger counts every change); it falls
 * back to the notice's own lines rather than claim a version no row recorded.
 */
export function consentVersion(settings: FormSettings): string {
  return consentReworded(settings.application) && settings.consentRevision > 0
    ? `${RECRUITMENT_POLICY_VERSION}.r${settings.consentRevision}`
    : RECRUITMENT_POLICY_VERSION;
}

export function applicationView(settings: FormSettings, locale: Locale): ApplicationView {
  const config = settings.application;
  const reworded = consentReworded(config) && settings.consentRevision > 0;
  const groups = Object.fromEntries(
    APPLICATION_GROUP_IDS.map((group) => [
      group,
      applicationGroupFields(config, group).map((field) => ({
        field,
        label:
          overrideOf(config.fields, field).label?.[locale] ?? APPLICATION_LABELS[field][locale],
        required: applicationRequired(config, field),
      })),
    ]),
  ) as ApplicationView['groups'];
  return {
    groups,
    button: config.button?.[locale] ?? null,
    consent: {
      application:
        (reworded ? config.consent?.application?.[locale] : undefined) ??
        RECRUITMENT_CONSENT[locale].application,
      futureRoles:
        (reworded ? config.consent?.futureRoles?.[locale] : undefined) ??
        RECRUITMENT_CONSENT[locale].futureRoles,
    },
    policyVersion: consentVersion(settings),
    requiredOptional: APPLICATION_OPTIONAL_FIELDS.filter((field) =>
      applicationRequired(config, field),
    ),
  };
}

export type ApplicationCheck =
  { ok: true; data: ApplicationInput; keepCv: boolean } | { ok: false; fields: string[] };

/**
 * A parsed application held to the published config: hidden controls dropped (the CV is not
 * stored), required ones refused when empty (`skills`, `linkedin`, `cv`), and a reworded
 * consent version accepted only up to the published revision (an older revision is a notice
 * a page really showed; a newer one never existed). `hasCv` is whether a file was sent. A
 * control the sending page did not show as required (`claim`, ./requiredClaim.ts) is not
 * refused for being empty; with no claim, the config decides alone.
 */
export function checkApplication(
  input: ApplicationInput,
  hasCv: boolean,
  settings: FormSettings,
  claim?: readonly string[],
): ApplicationCheck {
  const config = settings.application;
  const data: ApplicationInput = { ...input };
  const missing: string[] = [];

  const requires = (field: ApplicationOptionalField) =>
    applicationRequired(config, field) && claimRequires(claim, field);

  if (applicationHidden(config, 'skills')) data.skills = [];
  else if (requires('skills') && data.skills.length === 0) missing.push('skills');

  if (applicationHidden(config, 'linkedin')) delete data.linkedin;
  else if (requires('linkedin') && !data.linkedin) missing.push('linkedin');

  const keepCv = hasCv && !applicationHidden(config, 'cv');
  if (requires('cv') && !hasCv) missing.push('cv');

  const version = CONSENT_VERSION_PATTERN.exec(data.policyVersion);
  const revision = version?.[2] ? Number(version[2]) : 0;
  if (!version || revision > settings.consentRevision) missing.push('policyVersion');

  return missing.length > 0 ? { ok: false, fields: missing } : { ok: true, data, keepCv };
}
