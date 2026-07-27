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

export const AnalyticsEventSchema = z.object({
  // Closed set, not free text: an open `event_type` lets a client invent event names
  // that no dashboard reads and no retention rule anticipates.
  type: z.enum(['pageview', 'cta_click', 'service_interest', 'search']),
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
  props: z
    .record(z.string().max(40), z.union([z.string().max(200), z.number(), z.boolean()]))
    .refine((value) => Object.keys(value).length <= 10, { message: 'at most 10 props' })
    .optional(),
});
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
