import { z } from 'zod';

// Operational log line → public.system_logs (CLAUDE.md §10).
//
// This shape used to be a bare TypeScript `interface` inside the data layer — the only
// write path in the codebase with no runtime validation. `writeSystemLog()` is an exported
// server-side sink, so the boundary sat at whichever endpoint happened to call it
// (`/api/clientlog` validated; nothing else had to). Zod is the SINGLE boundary (§8), so
// it belongs here, next to the other write schemas.
//
// The caps are the point: `system_logs` is an append-only sink written on error paths,
// which is exactly when a runaway loop or an attacker-influenced string arrives. Bounding
// message/source length keeps one bad caller from filling the table. PII scrubbing is the
// caller's job via `src/lib/log/scrub.ts` — validation and redaction are separate concerns.

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export const LogLevelSchema = z.enum(LOG_LEVELS);
export type LogLevel = z.infer<typeof LogLevelSchema>;

export const SystemLogEntrySchema = z.object({
  level: LogLevelSchema,
  message: z.string().min(1).max(2000),
  source: z.string().min(1).max(120).optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});
export type SystemLogEntry = z.infer<typeof SystemLogEntrySchema>;
