import { z } from 'zod';
import { LocaleSchema } from './primitives';

// Public search input. The anon endpoint is NOT captcha-gated (CLAUDE.md §3); its safety
// envelope is: this Zod cap (≤64 chars, no control chars) + websearch_to_tsquery (never
// raw to_tsquery, in the search_content RPC) + a per-call statement_timeout + capped rows
// + WAF rate-limit (KAN-20). Zod is the single input boundary.

// Reject control characters: C0 (0x00-0x1F), DEL (0x7F), C1 (0x80-0x9F). Printable text
// only — Arabic, Latin, digits, punctuation all pass; tabs/newlines/escapes do not.
// Implemented as a code-point scan (not a regex literal) so it is unambiguous to read.
export function hasControlChars(s: string): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) return true;
  }
  return false;
}

export const SearchQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .min(2, 'too-short')
    .max(64, 'too-long')
    .refine((s) => !hasControlChars(s), 'control-chars'),
  locale: LocaleSchema.default('en'),
  // NOTE: result count is capped server-side by the search_content RPC's LIMIT — there is
  // deliberately no client-supplied `limit` (a validated-but-ignored param is a false
  // safety signal). Paging, if needed, lands as an explicit RPC arg + ticket.
});
export type SearchQuery = z.infer<typeof SearchQuerySchema>;

// One hit from the search_content RPC. The data layer validates each row against this and
// drops any that fail — same resilience as the other loaders.
export const SearchHitSchema = z.object({
  entity_type: z.enum(['service', 'portfolio', 'blog']),
  slug: z.string(),
  title: z.record(z.string(), z.string()),
  snippet: z.string().nullable(),
  rank: z.number(),
});
export type SearchHit = z.infer<typeof SearchHitSchema>;
