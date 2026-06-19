import { z } from 'zod';

// AI Style-Finder input boundary (CLAUDE.md §2 — logic deferred; ship the validated
// boundary now). Zod is the single input boundary; strict caps bound abuse + token cost
// before the request ever reaches a (future) model call.

export const StyleFinderInputSchema = z.object({
  // Opaque client session id (also the per-session rate-limit key). Bounded charset/length.
  sessionId: z
    .string()
    .min(8)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/, 'invalid-session'),
  // Quiz answers — capped count + per-value length to bound prompt size / cost.
  answers: z
    .array(
      z.object({
        questionId: z.string().min(1).max(64),
        value: z.string().min(1).max(280),
      }),
    )
    .min(1)
    .max(40),
});
export type StyleFinderInput = z.infer<typeof StyleFinderInputSchema>;
