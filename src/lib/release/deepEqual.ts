// Equality of JSON column values, for a pending change's no-op and conflict checks (Admin
// v2 R2). Two values are equal when their canonical JSON is: object keys in sorted order,
// a missing value the same as null, and an ISO timestamp compared as the instant it names
// (PostgREST answers `2026-01-02T03:04:05+00:00` where the form sent
// `2026-01-02T03:04:05.000Z`). This is for display and for discarding a change that
// restores the live value; the database's typed comparison in the apply (R4) is the gate
// of record for a conflict.

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;

/** The canonical form of a JSON value (see above). */
export function canonical(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    if (ISO_INSTANT.test(value)) {
      const time = Date.parse(value);
      if (!Number.isNaN(time)) return new Date(time).toISOString();
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) out[key] = canonical(item);
    }
    return out;
  }
  return value;
}

/** Whether two JSON column values are the same value. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
