import { z } from 'zod';

// Payload for the consent-gated RUM web-vitals beacon (POST /api/rum). Validated
// server-side; no row is written without analytics consent (CLAUDE.md §10).
export const WebVitalSchema = z.object({
  metric: z.enum(['LCP', 'INP', 'CLS', 'FCP', 'TTFB']),
  value: z.number().nonnegative(),
  rating: z.enum(['good', 'needs-improvement', 'poor']).optional(),
  path: z.string().min(1).max(2048),
  id: z.string().max(64).optional(),
});
export type WebVital = z.infer<typeof WebVitalSchema>;
