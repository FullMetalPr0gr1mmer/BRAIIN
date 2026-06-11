import { z } from 'zod';
import { LocaleSchema, SlugSchema } from './primitives';

// Public contact / project-inquiry submission. Validated SERVER-SIDE in the
// submit-contact-form Edge Function (CLAUDE.md Pillar 1). `budget`/`timeline` are
// commercially sensitive PII, gated to Admin/Developer downstream.

export const LeadKindSchema = z.enum(['contact', 'project_inquiry', 'style_finder']);
export type LeadKind = z.infer<typeof LeadKindSchema>;

export const BudgetBandSchema = z.enum(['lt_10k', '10k_50k', '50k_150k', 'gt_150k', 'undisclosed']);
export const TimelineBandSchema = z.enum(['asap', '1_3m', '3_6m', 'flexible']);

export const LeadInputSchema = z.object({
  kind: LeadKindSchema.default('contact'),
  locale: LocaleSchema.default('en'),
  name: z.string().min(1).max(120),
  email: z.string().email().max(254),
  phone: z.string().min(3).max(32).optional(),
  message: z.string().min(1).max(5000),
  serviceOfInterest: SlugSchema.optional(),
  budgetBand: BudgetBandSchema.optional(),
  timelineBand: TimelineBandSchema.optional(),
  consentMarketing: z.boolean().default(false),
  // Anti-spam: honeypot must be empty; captcha token verified server-side.
  hp: z.string().max(0).optional(),
  captchaToken: z.string().min(1),
});
export type LeadInput = z.infer<typeof LeadInputSchema>;
