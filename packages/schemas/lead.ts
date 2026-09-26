import { z } from 'zod';
import { LocaleSchema, SlugSchema } from './primitives';

// Public contact / project-inquiry submission. Validated SERVER-SIDE in the
// submit-contact-form Edge Function (CLAUDE.md Pillar 1). `budget`/`timeline` are
// commercially sensitive PII, gated to Admin/Developer downstream.

export const LeadKindSchema = z.enum(['contact', 'project_inquiry', 'style_finder']);
export type LeadKind = z.infer<typeof LeadKindSchema>;

// ── Budget bands ────────────────────────────────────────────────────────────────
// The UI v2 contact design offers the bands below. The previous form posted a different
// set; those keys stay ACCEPTED ON INPUT because pages are edge-cached for a year and
// there is no purge yet — a visitor holding a cached page would otherwise get a 422 for
// submitting exactly what the page offered them. Drop LEGACY_BUDGET_BANDS from the input
// union once cached pages have turned over (plan: "later cleanup"); keep them in the
// label map for as long as rows carrying them exist.
export const BUDGET_BANDS = ['lt_25k', '25k_75k', '75k_200k', 'gt_200k', 'not_sure'] as const;
export const LEGACY_BUDGET_BANDS = [
  'lt_10k',
  '10k_50k',
  '50k_150k',
  'gt_150k',
  'undisclosed',
] as const;
export const BudgetBandSchema = z.enum(BUDGET_BANDS);
export const AcceptedBudgetBandSchema = z.enum([...BUDGET_BANDS, ...LEGACY_BUDGET_BANDS]);
export type BudgetBand = z.infer<typeof AcceptedBudgetBandSchema>;

/** Deprecated with the v2 form (free-text `timelineText` replaces it); still accepted. */
export const TimelineBandSchema = z.enum(['asap', '1_3m', '3_6m', 'flexible']);

/**
 * The ONE label map for budget bands — the form, the admin leads panel and the CSV export
 * all read it, so a band never shows as a raw key anywhere. New bands carry the design's
 * copy verbatim, including its Arabic-Indic digits; legacy bands keep the labels the old
 * form showed, marked so an editor can tell which form a lead came through.
 */
export const BUDGET_BAND_LABELS: Record<BudgetBand, { en: string; ar: string }> = {
  lt_25k: { en: 'Under 25k SAR', ar: 'أقل من ٢٥ ألف ريال' },
  '25k_75k': { en: '25k to 75k SAR', ar: '٢٥ إلى ٧٥ ألف ريال' },
  '75k_200k': { en: '75k to 200k SAR', ar: '٧٥ إلى ٢٠٠ ألف ريال' },
  gt_200k: { en: '200k SAR and up', ar: '٢٠٠ ألف ريال فأكثر' },
  not_sure: { en: 'Not sure yet', ar: 'لسه ما حددنا' },
  lt_10k: { en: 'Under 10k SAR (legacy band)', ar: 'أقل من 10 آلاف ريال (فئة سابقة)' },
  '10k_50k': { en: '10k–50k SAR (legacy band)', ar: '10–50 ألف ريال (فئة سابقة)' },
  '50k_150k': { en: '50k–150k SAR (legacy band)', ar: '50–150 ألف ريال (فئة سابقة)' },
  gt_150k: { en: '150k+ SAR (legacy band)', ar: 'أكثر من 150 ألف ريال (فئة سابقة)' },
  undisclosed: { en: 'Prefer not to say (legacy band)', ar: 'أفضل عدم الإفصاح (فئة سابقة)' },
};

/** Label for a stored band key; unknown keys (hand-edited rows) render as themselves. */
export function budgetBandLabel(key: string, locale: 'en' | 'ar' = 'en'): string {
  return (BUDGET_BAND_LABELS as Record<string, { en: string; ar: string }>)[key]?.[locale] ?? key;
}

export const LeadInputSchema = z.object({
  kind: LeadKindSchema.default('contact'),
  locale: LocaleSchema.default('en'),
  name: z.string().min(1).max(120),
  // Business-contact data, NOT gated PII: it lives in leads_safe alongside `name`.
  // See supabase/migrations/0015_leads_company.sql for why it is not sensitive.
  company: z.string().trim().max(120).optional(),
  email: z.string().email().max(254),
  phone: z.string().min(3).max(32).optional(),
  message: z.string().min(1).max(5000),
  serviceOfInterest: SlugSchema.optional(),
  budgetBand: AcceptedBudgetBandSchema.optional(),
  /** Free-text "When do you need it?" — a §3 `timeline` field: encrypted, Admin/Developer only. */
  timelineText: z.string().trim().min(1).max(120).optional(),
  timelineBand: TimelineBandSchema.optional(),
  consentMarketing: z.boolean().default(false),
  // Anti-spam: honeypot must be empty; captcha token verified server-side once
  // reCAPTCHA is provisioned (KAN-20) — optional in v1 so the form works pre-launch
  // (honeypot + edge rate-limit cover spam until then).
  hp: z.string().max(0).optional(),
  captchaToken: z.string().min(1).optional(),
});
export type LeadInput = z.infer<typeof LeadInputSchema>;
