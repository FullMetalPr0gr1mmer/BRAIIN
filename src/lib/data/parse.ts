import type { z } from 'zod';

// Shared validation boundary for the public read loaders.
//
// Every loader used to do `parsed.success ? [parsed.data] : []` — correct, but it made an
// invalid row VANISH from the site with no trace. A missing case study then looks
// identical to an unpublished one, and there is nothing to search for. DoD #6 requires
// these to be observable, so rejections are logged here in one place.
//
// Deliberately console-only: these run on the Tier-A SSR read path, which is edge-cached
// and latency-sensitive — a DB write per malformed row would turn a content typo into a
// write amplifier. Worker logs are captured by Cloudflare observability (wrangler.jsonc).
//
// Logs field PATHS and the row slug, never field VALUES: content rows are not PII, but
// keeping values out of logs means this helper stays safe if it is ever pointed at a
// table that is (CLAUDE.md Pillar 1 — `src/lib/log/scrub.ts` is the other half).

/** `slug` if the raw row has a string one — the only value we echo, for diagnosis. */
function rowSlug(row: unknown): string {
  if (typeof row === 'object' && row !== null && 'slug' in row) {
    const slug = (row as { slug: unknown }).slug;
    if (typeof slug === 'string') return slug;
  }
  return '<no-slug>';
}

function reportDrop(entity: string, row: unknown, error: z.ZodError): void {
  const paths = error.issues.map((i) => i.path.join('.') || '<root>').join(', ');
  console.warn(`[content] dropped invalid ${entity} row (slug=${rowSlug(row)}): ${paths}`);
}

/** Validate a list; drop + log rows that fail. Returns only well-formed rows. */
export function parseRows<S extends z.ZodTypeAny>(
  schema: S,
  rows: unknown[],
  entity: string,
): z.infer<S>[] {
  return rows.flatMap((row) => {
    const parsed = schema.safeParse(row);
    if (parsed.success) return [parsed.data as z.infer<S>];
    reportDrop(entity, row, parsed.error);
    return [];
  });
}

/** Validate a single row; log + return null when it fails. */
export function parseRow<S extends z.ZodTypeAny>(
  schema: S,
  row: unknown,
  entity: string,
): z.infer<S> | null {
  const parsed = schema.safeParse(row);
  if (parsed.success) return parsed.data as z.infer<S>;
  reportDrop(entity, row, parsed.error);
  return null;
}
