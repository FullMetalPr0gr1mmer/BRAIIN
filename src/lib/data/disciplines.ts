import {
  DisciplineRowSchema,
  PUBLIC_MEDIA_COLUMNS,
  type DisciplineRow,
  type LocalizedText,
  type ServiceRow,
} from '@schemas/content';
import type { VideoClip } from '@schemas/media';
import { anonClient, supabaseConfigured } from '@/lib/supabase/client';
import { clipOf, imageRef, type ImageRef } from '@/lib/media/resolve';
import { parseRows, reportLoadError } from './parse';
import { loadPublishedServiceRows, toServiceSummary, type ServiceSummary } from './services';

// The five disciplines (0028) with their services, for the home cards, the /services
// cards and explorer, a service page's "More in {Discipline}", and the grouped service
// select on every inquiry form. Tier A SSR reads under RLS: published disciplines only
// (disciplines_read), and only services of a published discipline
// (services_discipline_published) — the two agree without this file checking either.
//
// Two queries in parallel rather than one nested embed: the services select is the same
// one getPublishedServices runs (one shape, one schema, one place a column is named),
// and grouping 28 rows in memory costs nothing.
//
// Fail closed as a WHOLE: if either query fails the result is [] and the page renders its
// code fallback — never five cards that each claim "0 services" because the second query
// timed out.

const MEDIA = `(${PUBLIC_MEDIA_COLUMNS})`;

// Only columns anon is granted on disciplines (0028) — `*` would be a permission error.
export const DISCIPLINE_COLUMNS =
  'id,slug,name,short,blurb,sort_order,updated_at,preview_video_path,preview_start_s,' +
  `preview_end_s,poster:poster_media_id${MEDIA}`;

export interface Discipline {
  id: string;
  slug: string;
  name: LocalizedText;
  /** The card line ("The mark, the system, and everything it touches."). */
  short: LocalizedText | null;
  /** The explorer paragraph. */
  blurb: LocalizedText | null;
  sortOrder: number;
  updatedAt: string | null;
  poster: ImageRef | null;
  /** The card's hover loop / the explorer's clip (EXC-009 window of the showreel). */
  clip: VideoClip | null;
  /** Its published services, in sort_order. `services.length` is the card's count. */
  services: ServiceSummary[];
}

export function toDiscipline(row: DisciplineRow, services: readonly ServiceRow[]): Discipline {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    short: row.short,
    blurb: row.blurb,
    sortOrder: row.sort_order,
    updatedAt: row.updated_at,
    poster: imageRef(row.poster),
    clip: clipOf({
      uid: null,
      path: row.preview_video_path,
      startS: row.preview_start_s,
      endS: row.preview_end_s,
    }),
    services: services
      .filter((s) => s.discipline_id === row.id)
      .sort((a, b) => a.sort_order - b.sort_order)
      .map(toServiceSummary),
  };
}

/** Published disciplines in sort_order, each with its published services in sort_order. */
export async function getPublishedDisciplines(): Promise<Discipline[]> {
  if (!supabaseConfigured()) return [];
  try {
    const [disciplines, services] = await Promise.all([
      anonClient()
        .from('disciplines')
        .select(DISCIPLINE_COLUMNS)
        .eq('status', 'published')
        .order('sort_order', { ascending: true }),
      loadPublishedServiceRows(),
    ]);
    if (disciplines.error) {
      reportLoadError('disciplines', disciplines.error);
      return [];
    }
    // The services query already logged its own failure.
    if (services === null) return [];
    return parseRows(DisciplineRowSchema, disciplines.data ?? [], 'discipline').map((row) =>
      toDiscipline(row, services),
    );
  } catch (err) {
    reportLoadError('disciplines', err);
    return [];
  }
}
