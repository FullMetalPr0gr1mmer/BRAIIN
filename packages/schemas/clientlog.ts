import { z } from 'zod';

// Payload for the first-party client error reporter (POST /api/clientlog).
// Operational telemetry = legitimate-interest, consent-independent, PII-scrubbed
// server-side before persistence (CLAUDE.md §8.2 / §10).
export const ClientLogSchema = z.object({
  level: z.enum(['error', 'warn']),
  message: z.string().min(1).max(2000),
  source: z.string().max(512).optional(),
  line: z.number().int().nonnegative().optional(),
  col: z.number().int().nonnegative().optional(),
  path: z.string().min(1).max(2048),
});
export type ClientLog = z.infer<typeof ClientLogSchema>;
