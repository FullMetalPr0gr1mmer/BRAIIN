import { jsonEqual } from '@/lib/release/deepEqual';

// The Join consent revision a write WOULD give the forms config (Admin v2 E8), for the places
// that show a pending change before the database has counted it: the releases preview (a
// staged rewording shows its own lines and the version it will post) and the Forms editor in
// release mode (the version a publish will post). It mirrors app.tg_form_consent_revision (the
// E8 migration), the one place that really counts: an insert is 1 when the row words the
// consent lines, else 0; an update is one more when `application -> 'consent'` changes,
// compared by value as jsonb compares it. Zod-free.

type Row = Record<string, unknown>;

const isRecord = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `application -> 'consent'` of a form_settings row: the consent lines, or null. */
export function consentOf(application: unknown): unknown {
  return isRecord(application) && application['consent'] !== undefined
    ? application['consent']
    : null;
}

/** The revision `next` would have once written over `live` (null: no row yet, an insert). */
export function projectedConsentRevision(live: Row | null, next: Row): number {
  if (!live) return isRecord(next['application']) && 'consent' in next['application'] ? 1 : 0;
  const now = Number(live['consent_revision']);
  const base = Number.isInteger(now) && now >= 0 ? now : 0;
  return base + (jsonEqual(consentOf(live['application']), consentOf(next['application'])) ? 0 : 1);
}
