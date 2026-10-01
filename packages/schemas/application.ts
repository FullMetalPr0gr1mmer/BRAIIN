import { z } from 'zod';
import { LocaleSchema } from './primitives';

// The Join application (careers page, `/join` + `/ar/join`) — the second public write
// path after the contact form, and the first with a file. One shape for the form, the
// endpoint, the admin and the tests (CLAUDE.md §8: Zod is the single input boundary).
//
// Unlike LeadInputSchema this schema is STRICT: an unknown key is a 422, never silently
// dropped, so a form field renamed on one side cannot quietly stop being stored.
//
// The option lists are code-owned and bilingual, stored by stable key (never by the
// English label the design posted): a renamed label must not orphan existing rows.

/** CV rules (owner decision J2, 2026-09-30): PDF or .docx, at most 10 MB. */
export const CV_MAX_BYTES = 10 * 1024 * 1024;
/** Multipart overhead allowed on top of the CV: the text fields and part headers. */
export const APPLY_BODY_OVERHEAD_BYTES = 64 * 1024;
export const APPLY_BODY_MAX_BYTES = CV_MAX_BYTES + APPLY_BODY_OVERHEAD_BYTES;

export const CV_KINDS = {
  pdf: { contentType: 'application/pdf', extension: 'pdf' },
  docx: {
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extension: 'docx',
  },
} as const;
export type CvKind = keyof typeof CV_KINDS;

interface Labelled {
  readonly en: string;
  readonly ar: string;
}

/** "Experience" — verbatim from the design (join.html), stored by key. */
export const EXPERIENCE_LEVELS = {
  student: { en: 'Student or graduate', ar: 'طالب أو خريج' },
  '1-3': { en: '1 to 3 years', ar: 'من سنة إلى ٣ سنوات' },
  '3-6': { en: '3 to 6 years', ar: 'من ٣ إلى ٦ سنوات' },
  '6-plus': { en: '6+ years', ar: 'أكثر من ٦ سنوات' },
} as const satisfies Record<string, Labelled>;

/** "How you'd like to work". */
export const WORK_TYPES = {
  'full-time': { en: 'Full-time', ar: 'دوام كامل' },
  freelance: { en: 'Freelance', ar: 'عمل حر' },
  internship: { en: 'Internship', ar: 'تدريب' },
  any: { en: 'Open to any', ar: 'أي شكل' },
} as const satisfies Record<string, Labelled>;

/** "When could you start?". */
export const AVAILABILITY = {
  immediately: { en: 'Immediately', ar: 'فوراً' },
  'two-weeks': { en: 'Within two weeks', ar: 'خلال أسبوعين' },
  month: { en: 'Within a month', ar: 'خلال شهر' },
  later: { en: 'In more than a month', ar: 'بعد أكثر من شهر' },
} as const satisfies Record<string, Labelled>;

/**
 * "Crafts you work in" — the design's 16 chips as written (owner decision J3). They name a
 * person's skills, not what the studio sells, so they are independent of the services
 * table: Gaming and Merchandise stay although Round 2 retired those services.
 */
export const CRAFTS = {
  branding: { en: 'Branding', ar: 'الهوية البصرية' },
  animation: { en: 'Animation', ar: 'الرسوم المتحركة' },
  'motion-graphics': { en: 'Motion Graphics', ar: 'الموشن جرافيك' },
  videography: { en: 'Videography', ar: 'الإنتاج المرئي' },
  photography: { en: 'Photography', ar: 'التصوير الفوتوغرافي' },
  montage: { en: 'Montage', ar: 'المونتاج' },
  'event-planning': { en: 'Event Planning', ar: 'تنظيم الفعاليات' },
  advertising: { en: 'Advertising', ar: 'الإعلان' },
  'social-media': { en: 'Social Media', ar: 'السوشيال ميديا' },
  'web-development': { en: 'Web Development', ar: 'تطوير المواقع' },
  'seo-geo-aeo': { en: 'SEO / GEO / AEO', ar: 'تحسين الظهور' },
  music: { en: 'Music', ar: 'الموسيقى' },
  merchandise: { en: 'Merchandise', ar: 'المنتجات الترويجية' },
  gaming: { en: 'Gaming', ar: 'الألعاب' },
  copywriting: { en: 'Copywriting', ar: 'كتابة المحتوى' },
  strategy: { en: 'Strategy', ar: 'الاستراتيجية' },
} as const satisfies Record<string, Labelled>;

const keysOf = <T extends Record<string, unknown>>(o: T) =>
  Object.keys(o) as [keyof T & string, ...(keyof T & string)[]];

export const ExperienceSchema = z.enum(keysOf(EXPERIENCE_LEVELS));
export const WorkTypeSchema = z.enum(keysOf(WORK_TYPES));
export const AvailabilitySchema = z.enum(keysOf(AVAILABILITY));
export const CraftSchema = z.enum(keysOf(CRAFTS));

/** Labels for a stored key; an unknown key (a hand-edited row) renders as itself. */
export function optionLabel(
  table: Record<string, Labelled>,
  key: string,
  locale: 'en' | 'ar' = 'en',
): string {
  return table[key]?.[locale] ?? key;
}

/** https only — a portfolio or profile link the admin will open. */
const HttpsUrl = z
  .string()
  .trim()
  .max(2048)
  .url()
  .refine((v) => /^https:\/\//i.test(v), 'must be an https:// link');

/**
 * The recruitment notice version the form was shown. Bumped when the consent text in
 * packages/consent/recruitment.ts changes; stored on the row as the consent record.
 */
export const RecruitmentPolicyVersionSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const ApplicationInputSchema = z
  .object({
    locale: LocaleSchema,
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().email().max(254),
    phone: z.string().trim().min(6).max(32),
    city: z.string().trim().min(1).max(80),
    role: z.string().trim().min(1).max(120),
    experience: ExperienceSchema,
    workType: WorkTypeSchema,
    availability: AvailabilitySchema,
    skills: z.array(CraftSchema).max(Object.keys(CRAFTS).length),
    portfolio: HttpsUrl,
    linkedin: HttpsUrl.optional(),
    message: z.string().trim().min(1).max(4000),
    /** Required: keep and process THIS application (owner decision J4). */
    consentApplication: z.literal(true),
    /** Optional: contact me about future roles — keeps the application 24 months, not 12. */
    consentFutureRoles: z.boolean(),
    policyVersion: RecruitmentPolicyVersionSchema,
  })
  .strict();
export type ApplicationInput = z.infer<typeof ApplicationInputSchema>;

/**
 * Every answer the endpoint gives, and the only words the page shows (one status region,
 * one message per status). With `Accept: application/json` the endpoint returns
 * `{ status, fields? }`; a plain form post is answered with a 303 to
 * `/join?status=<status>#apply` (or `/ar/join…`).
 */
export const APPLY_STATUSES = [
  'ok',
  'invalid',
  'too_large',
  'bad_type',
  'rate_limited',
  'unavailable',
  'closed',
  'error',
] as const;
export const ApplyStatusSchema = z.enum(APPLY_STATUSES);
export type ApplyStatus = z.infer<typeof ApplyStatusSchema>;

export const APPLY_HTTP_STATUS: Record<ApplyStatus, number> = {
  ok: 200,
  invalid: 422,
  too_large: 413,
  bad_type: 415,
  rate_limited: 429,
  unavailable: 503,
  closed: 409,
  error: 500,
};

/** The form's control names → the schema key they fill (one map, both directions). */
export const APPLICATION_FORM_FIELDS = {
  name: 'name',
  email: 'email',
  phone: 'phone',
  city: 'city',
  role: 'role',
  experience: 'experience',
  work_type: 'workType',
  availability: 'availability',
  skills: 'skills',
  portfolio: 'portfolio',
  linkedin: 'linkedin',
  message: 'message',
  consent_application: 'consentApplication',
  consent_future: 'consentFutureRoles',
  policy_version: 'policyVersion',
  locale: 'locale',
} as const;
export type ApplicationFormField = keyof typeof APPLICATION_FORM_FIELDS;
/** The file input, the honeypot. Not schema keys. */
export const CV_FIELD = 'cv';
export const HONEYPOT_FIELD = 'hp';

const SCHEMA_TO_FORM = Object.fromEntries(
  Object.entries(APPLICATION_FORM_FIELDS).map(([form, key]) => [key, form]),
) as Record<string, ApplicationFormField>;

/** A schema key the server named in a 422 → the control the form marks. */
export function applicationKeyToField(key: string): string {
  return SCHEMA_TO_FORM[key] ?? key;
}

type FormLike = Pick<FormData, 'get' | 'getAll'>;

/**
 * The submitted form → the schema's input object. Pure: "" becomes undefined (so an
 * empty optional field is absent, and an empty required one fails as missing), a
 * checkbox counts as checked only when it was sent, and skills are every `skills` value.
 */
export function formToApplicationInput(form: FormLike): Record<string, unknown> {
  const text = (name: ApplicationFormField): string | undefined => {
    const v = form.get(name);
    if (typeof v !== 'string') return undefined;
    const t = v.trim();
    return t === '' ? undefined : t;
  };
  const checked = (name: ApplicationFormField) => {
    const v = form.get(name);
    return typeof v === 'string' && v !== '';
  };
  const out: Record<string, unknown> = {
    locale: text('locale'),
    name: text('name'),
    email: text('email'),
    phone: text('phone'),
    city: text('city'),
    role: text('role'),
    experience: text('experience'),
    workType: text('work_type'),
    availability: text('availability'),
    skills: form.getAll('skills').filter((v): v is string => typeof v === 'string' && v !== ''),
    portfolio: text('portfolio'),
    linkedin: text('linkedin'),
    message: text('message'),
    consentApplication: checked('consent_application') ? true : undefined,
    consentFutureRoles: checked('consent_future'),
    policyVersion: text('policy_version'),
  };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

/** Admin statuses for an application. `spam` shortens retention to 30 days (0029). */
export const APPLICATION_STATUSES = [
  'new',
  'in_review',
  'shortlisted',
  'declined',
  'hired',
  'spam',
] as const;
export const ApplicationStatusSchema = z.enum(APPLICATION_STATUSES);
export type ApplicationStatus = z.infer<typeof ApplicationStatusSchema>;

export const ApplicationUpdateSchema = z
  .object({
    status: ApplicationStatusSchema.optional(),
    internalNotes: z.string().max(5000).optional(),
  })
  .strict();

export const ApplicationListQuerySchema = z.object({
  status: ApplicationStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Retention horizons (months), set on the row at insert. Admin cannot extend them. */
export const APPLICATION_RETENTION_MONTHS = { application: 12, futureRoles: 24 } as const;
export const SPAM_RETENTION_DAYS = 30;
