import type { SupabaseClient } from '@supabase/supabase-js';
import { FALLBACK_DISCIPLINES } from '@/lib/services/cards';
import {
  RENAMED_SERVICE_SLUGS,
  RETIRED_SERVICES,
  RETIRED_SERVICE_TITLES,
  renamedServiceSlug,
} from '@/lib/services/retired';
import { writeSystemLog } from '@/lib/data/systemLog';

// Readable labels for a lead's `service_of_interest` / `discipline_of_interest` slugs
// (Round 3, owner decision G1): every slug a lead can carry — old or new, EN and AR —
// shows as a label beside the raw value; stored rows are never rewritten.
//
// Why a lookup and not a code map: the titles live in `services` / `disciplines`, and the
// staff read (services_read 0001, disciplines_read 0028) includes drafts and archived rows,
// so an archived slug is labelled from its OWN row ("Branding (retired)") — which is also
// what settles `branding`, a slug that is both an archived service and a live discipline.
// The lookup runs on the caller's RLS-bound connection: Developer holds `leads.*` but not
// `services.write`, so the label must be resolved server-side, never by the panel.
//
// Order, per slug:
//   service     its row (archived → "Title (retired)") → renamed (`videography` → its OLD
//               title from RENAMED_SERVICE_SLUGS + the `photo-video` row's title,
//               "Videography (now Photography / Videography)" / "الإنتاج المرئي (الآن …)")
//               → any other retired slug, by its old title from RETIRED_SERVICE_TITLES
//               ("Merchandise (retired)" / "المنتجات الترويجية (متوقفة)") → the raw slug
//   discipline  its row → FALLBACK_DISCIPLINES (the five, text only) → the raw slug
// The two orders differ on purpose: a discipline slug must never fall into the retired
// SERVICE map (`branding` is in both).
//
// A failed table read is fail-open (the fallbacks label everything) but never silent: it
// is written to system_logs as a warning naming the table and the batch size — no slug,
// no label text, no lead field.

export type InterestKind = 'service' | 'discipline';

export type InterestStatus =
  'published' | 'draft' | 'scheduled' | 'archived' | 'renamed' | 'retired' | 'fallback' | 'unknown';

export interface InterestLabel {
  /** The slug as stored on the lead. */
  slug: string;
  label: { en: string; ar: string };
  status: InterestStatus;
  /** Where that interest lives now: the renamed slug for a rename, else `slug`. */
  currentSlug: string;
}

export type InterestLabels = Map<`${InterestKind}:${string}`, InterestLabel>;

/** The row shape a lead is read in — only the two slug columns matter here. */
export interface LeadInterestRow {
  service_of_interest?: unknown;
  discipline_of_interest?: unknown;
}

interface TitledRow {
  slug: string;
  title: { en: string; ar: string };
  status: InterestStatus;
}

const RETIRED_SUFFIX = { en: ' (retired)', ar: ' (متوقفة)' } as const;

/** `photo-video` → "Photo Video": the last resort when a row cannot be read. */
export function humanizeSlug(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

const humanized = (slug: string): { en: string; ar: string } => {
  const text = humanizeSlug(slug);
  return { en: text, ar: text };
};

/** The one log line for a failed read: table + batch size only, never the slugs. */
async function logReadFailure(table: string, count: number): Promise<void> {
  await writeSystemLog({
    level: 'warn',
    source: 'lead-labels',
    message: `lead interest labels: the ${table} read failed; labels fell back to code`,
    detail: { table, count },
  });
}

const isText = (v: unknown): v is { en: string; ar: string } =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as Record<string, unknown>)['en'] === 'string' &&
  typeof (v as Record<string, unknown>)['ar'] === 'string';

const slugOf = (row: LeadInterestRow, kind: InterestKind): string | null => {
  const raw = kind === 'service' ? row.service_of_interest : row.discipline_of_interest;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
};

const STATUSES: readonly string[] = ['published', 'draft', 'scheduled', 'archived'];

/**
 * One `.in('slug', …)` query per table, tolerant of a stub client (a test double that
 * answers every table with lead rows, or with rows lacking `slug`) and of a failed read:
 * a row that cannot be read is simply not a DB label, and the fallbacks take over — after
 * one warning in system_logs, so a broken read is not mistaken for missing rows.
 */
async function readTitled(
  sb: SupabaseClient,
  table: 'services' | 'disciplines',
  tenantId: string,
  slugs: readonly string[],
): Promise<Map<string, TitledRow>> {
  const out = new Map<string, TitledRow>();
  if (slugs.length === 0) return out;
  const titleColumn = table === 'services' ? 'title' : 'name';
  try {
    const { data, error } = await sb
      .from(table)
      .select(`slug,${titleColumn},status`)
      .eq('tenant_id', tenantId)
      .in('slug', [...slugs]);
    if (error) {
      await logReadFailure(table, slugs.length);
      return out;
    }
    if (!Array.isArray(data)) return out;
    for (const row of data as unknown as Record<string, unknown>[]) {
      const slug = row['slug'];
      const title = row[titleColumn];
      if (typeof slug !== 'string' || !isText(title)) continue;
      const status = String(row['status']);
      out.set(slug, {
        slug,
        title,
        status: (STATUSES.includes(status) ? status : 'unknown') as InterestStatus,
      });
    }
  } catch {
    await logReadFailure(table, slugs.length); // fail open — see above
  }
  return out;
}

function serviceLabel(slug: string, rows: Map<string, TitledRow>): InterestLabel {
  const own = rows.get(slug);
  if (own) {
    const retired = own.status === 'archived';
    return {
      slug,
      status: own.status,
      currentSlug: slug,
      label: retired
        ? { en: own.title.en + RETIRED_SUFFIX.en, ar: own.title.ar + RETIRED_SUFFIX.ar }
        : own.title,
    };
  }
  const renamed = renamedServiceSlug(slug);
  if (renamed) {
    const now = rows.get(renamed);
    const old = RENAMED_SERVICE_SLUGS[slug] ?? humanized(slug);
    return {
      slug,
      status: 'renamed',
      currentSlug: renamed,
      label: {
        en: `${old.en} (now ${now?.title.en ?? humanizeSlug(renamed)})`,
        ar: `${old.ar} (الآن ${now?.title.ar ?? humanizeSlug(renamed)})`,
      },
    };
  }
  if (Object.hasOwn(RETIRED_SERVICES, slug)) {
    const old = RETIRED_SERVICE_TITLES[slug] ?? humanized(slug);
    return {
      slug,
      status: 'retired',
      currentSlug: slug,
      label: { en: old.en + RETIRED_SUFFIX.en, ar: old.ar + RETIRED_SUFFIX.ar },
    };
  }
  return { slug, status: 'unknown', currentSlug: slug, label: { en: slug, ar: slug } };
}

function disciplineLabel(slug: string, rows: Map<string, TitledRow>): InterestLabel {
  const own = rows.get(slug);
  if (own) return { slug, status: own.status, currentSlug: slug, label: own.title };
  const fallback = FALLBACK_DISCIPLINES.find((d) => d.slug === slug);
  if (fallback) return { slug, status: 'fallback', currentSlug: slug, label: fallback.name };
  return { slug, status: 'unknown', currentSlug: slug, label: { en: slug, ar: slug } };
}

/**
 * Labels for every service / discipline slug the given lead rows carry: at most two
 * queries (one per table, explicit `tenant_id`), under the caller's connection.
 */
export async function resolveLeadInterests(
  sb: SupabaseClient,
  tenantId: string,
  rows: readonly LeadInterestRow[],
): Promise<InterestLabels> {
  const services = new Set<string>();
  const disciplines = new Set<string>();
  for (const row of rows) {
    const service = slugOf(row, 'service');
    const discipline = slugOf(row, 'discipline');
    if (service) services.add(service);
    if (discipline) disciplines.add(discipline);
  }
  // A renamed slug is labelled from the row it moved to — fetched in the same query.
  const serviceLookup = new Set(services);
  for (const slug of services) {
    const renamed = renamedServiceSlug(slug);
    if (renamed) serviceLookup.add(renamed);
  }

  const [serviceRows, disciplineRows] = await Promise.all([
    readTitled(sb, 'services', tenantId, [...serviceLookup]),
    readTitled(sb, 'disciplines', tenantId, [...disciplines]),
  ]);

  const out: InterestLabels = new Map();
  for (const slug of services) out.set(`service:${slug}`, serviceLabel(slug, serviceRows));
  for (const slug of disciplines) {
    out.set(`discipline:${slug}`, disciplineLabel(slug, disciplineRows));
  }
  return out;
}

/**
 * The lead row plus its derived label fields (`service_label`, `service_status`,
 * `discipline_label`) — derived on the way out, never columns; a row with no interest
 * gets none of them. `stripSensitive` is untouched: nothing here is PII.
 */
export function withInterestLabels<T extends LeadInterestRow>(
  row: T,
  labels: InterestLabels,
): T & {
  service_label?: { en: string; ar: string };
  service_status?: InterestStatus;
  discipline_label?: { en: string; ar: string };
} {
  const out: T & {
    service_label?: { en: string; ar: string };
    service_status?: InterestStatus;
    discipline_label?: { en: string; ar: string };
  } = { ...row };
  const service = slugOf(row, 'service');
  const discipline = slugOf(row, 'discipline');
  const s = service ? labels.get(`service:${service}`) : undefined;
  const d = discipline ? labels.get(`discipline:${discipline}`) : undefined;
  if (s) {
    out.service_label = s.label;
    out.service_status = s.status;
  }
  if (d) out.discipline_label = d.label;
  return out;
}
