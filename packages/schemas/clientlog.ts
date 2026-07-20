import { z } from 'zod';

// Payload for the first-party client error reporter (POST /api/clientlog).
// Operational telemetry = legitimate-interest, consent-independent, PII-scrubbed
// server-side before persistence (CLAUDE.md §8.2 / §10).
export const ClientLogSchema = z.object({
  level: z.enum(['error', 'warn']),
  message: z.string().min(1).max(2000),
  // 120, matching SystemLogEntrySchema's cap — NOT 512. The two disagreed, so a source
  // of 121-512 chars passed here, was rejected at the sink, and the client still got a
  // 204: the log line vanished and nothing reported it. A boundary that accepts more
  // than the sink stores is a silent data-loss machine.
  source: z.string().max(120).optional(),
  line: z.number().int().nonnegative().optional(),
  col: z.number().int().nonnegative().optional(),
  path: z.string().min(1).max(2048),
});
export type ClientLog = z.infer<typeof ClientLogSchema>;
