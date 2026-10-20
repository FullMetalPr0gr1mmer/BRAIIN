import { z } from 'zod';
import { LocaleSchema } from './primitives';

// First-party analytics event — the single canonical source (CLAUDE.md Pillar 4:
// "one analytics source; no double-write"). GA4, if configured, is secondary and
// consent-gated separately.
//
// Every field is bounded. This is an UNAUTHENTICATED write path that reaches a
// service-role insert, so the schema is the row-size bound (the WAF rate limit is the
// row-count bound). An unbounded `path` or `props` here is a storage-amplification
// primitive available to anyone with curl.
//
// Admin v2 G1: each type carries exactly the props its rollup reads, nothing else
// (`.strict()` everywhere: an unknown key is a 422). The click vocabulary is closed (CTA_IDS),
// so a client cannot invent event names no dashboard reads and no retention rule anticipates.

/**
 * The links the public site counts a click on (`data-track="<id>"`, one delegated listener in
 * src/lib/client/analytics.ts). Only ids that render: there is no `tel:` link on the site, so
 * no phone id. tests/lib/analyticsVocabulary.spec.ts holds this list equal to the values the
 * components render, each one used.
 */
export const CTA_IDS = [
  'whatsapp',
  'email',
  'skip_to_inquiry',
  'start_project',
  'language_ar',
  'language_en',
  'discipline_card',
  'project_card',
  'contact_link',
] as const;
export type CtaId = (typeof CTA_IDS)[number];

/**
 * The clicks that count as "reached an inquiry form" in the stats funnel, beside a page view
 * of the contact page. Mirrored as a literal in the visits rollup (migration 0071,
 * app.rollup_visits); the vocabulary spec holds the two equal.
 */
export const INQUIRY_CTAS = [
  'skip_to_inquiry',
  'start_project',
  'contact_link',
] as const satisfies readonly CtaId[];

/** A service page, in either language (the funnel's second step). Equal to the rollup's. */
export const SERVICE_PATH = /^(\/ar)?\/services\/[^/?#]+\/?$/;
/** The contact page, in either language (an inquiry form). Equal to the rollup's. */
export const INQUIRY_PATH = /^(\/ar)?\/contact\/?$/;

/** A discipline's or a service's slug, as the explorer names it. */
const InterestSlugSchema = z.string().regex(/^[a-z0-9-]{1,64}$/);

const base = {
  /** Site-relative path only — never a full URL, which could carry a query string. */
  path: z
    .string()
    .max(512)
    .regex(/^\/[^\s?#]*$/, 'must be a site-relative path')
    .optional(),
  locale: LocaleSchema.default('en'),
  /**
   * Opaque per-visit id minted client-side. NOT a user identifier and never joined to
   * one — it exists so "sessions" is countable. Bounded so it cannot smuggle a payload.
   */
  sessionId: z
    .string()
    .max(64)
    .regex(/^[A-Za-z0-9_-]*$/)
    .optional(),
};

export const AnalyticsEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('pageview'), ...base }).strict(),
  z
    .object({
      type: z.literal('cta_click'),
      ...base,
      props: z.object({ cta: z.enum(CTA_IDS) }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('service_interest'),
      ...base,
      // Exactly one of the two: a discipline's panel opened, or a service chosen.
      props: z.union([
        z.object({ discipline: InterestSlugSchema }).strict(),
        z.object({ service: InterestSlugSchema }).strict(),
      ]),
    })
    .strict(),
  // Nothing sends it yet (the search endpoint logs its own ledger); kept in the closed set
  // with no props.
  z.object({ type: z.literal('search'), ...base }).strict(),
]);
export type AnalyticsEvent = z.infer<typeof AnalyticsEventSchema>;

/** Consent record posted by the banner. */
export const ConsentRecordSchema = z.object({
  categories: z.object({
    functional: z.boolean(),
    analytics: z.boolean(),
    marketing: z.boolean(),
  }),
  policyVersion: z.string().max(20),
  action: z.enum(['grant', 'withdraw']).default('grant'),
});
export type ConsentRecord = z.infer<typeof ConsentRecordSchema>;
