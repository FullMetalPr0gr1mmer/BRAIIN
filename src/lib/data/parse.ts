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

/**
 * A loader's QUERY failed (as opposed to a row failing validation). Loaders fail closed to
 * `[]`/null so a page still renders — which also means a 42501 from a missing grant, a
 * PGRST204 from a column the database does not have yet, or a timeout all look exactly
 * like "no content" on the page. This makes them diagnosable: the Postgres/PostgREST
 * error CODE and entity, never the message body (it can quote values).
 */
export function reportLoadError(
  entity: string,
  error: { code?: string | undefined } | unknown,
): void {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : error instanceof Error
        ? error.name
        : 'unknown';
  console.warn(`[content] ${entity} load failed (code=${code}) — rendering the fallback`);
}

/**
 * A STORED article body (one language) that rendered nothing because the renderer refused it or
 * its render threw (H15 code review, CR1): the page still renders, without that body, and this
 * line is what makes it diagnosable. The entity, the row's id, the language and the refusal
 * (the walk's plain words or an error's name), never the body's content.
 */
export function reportBodyRefused(entity: string, id: string, lang: string, reason: string): void {
  console.warn(
    `[content] ${entity} body not rendered (id=${logSafe(id)}, lang=${logSafe(lang)}): ${logSafe(reason)}`,
  );
}

/**
 * A value made safe for one log line (H15 check): a refusal reason can quote a stored node or
 * mark type, which a row written around the Worker controls. Anything quoted is replaced by an
 * ellipsis (never stored content in a log), control characters (a forged second line) become
 * spaces, and the whole is capped.
 */
export function logSafe(value: string): string {
  const unquoted = value.replace(/"[^"]*"?/g, '"…"');
  let out = '';
  for (const ch of unquoted) {
    const code = ch.codePointAt(0) ?? 0;
    const control =
      code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
    out += control ? ' ' : ch;
  }
  return out.slice(0, 200);
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

/**
 * Maps validated rows to what a page renders, each row inside its own guard (H15): a row whose
 * mapping throws is dropped and logged (its slug and the error's name, never a value), so one
 * bad row is a 404 or a missing entry, never a 500 or an empty list. The page and its discovery
 * index map through the same call, so they still agree on which rows exist.
 */
export function mapRows<T, U>(rows: readonly T[], map: (row: T) => U, entity: string): U[] {
  return rows.flatMap((row) => {
    try {
      return [map(row)];
    } catch (err) {
      const name = err instanceof Error ? err.name : 'unknown';
      console.warn(`[content] dropped ${entity} row (slug=${rowSlug(row)}): unreadable (${name})`);
      return [];
    }
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

/**
 * The latest of some timestamps (as PostgREST writes them), as written; null for none. A
 * page's last change is its row's or a section's (Admin v2 E11 review E11-C2).
 */
export function latestInstant(values: readonly unknown[]): string | null {
  let best: string | null = null;
  let bestAt = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const at = Date.parse(value);
    if (Number.isNaN(at) || at <= bestAt) continue;
    best = value;
    bestAt = at;
  }
  return best;
}
