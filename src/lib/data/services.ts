import {
  PUBLIC_MEDIA_COLUMNS,
  ServiceDetailRowSchema,
  ServiceRowSchema,
  type LocalizedProse,
  type LocalizedText,
  type ServiceDetailRow,
  type ServiceRow,
  type ValuePoint,
} from '@schemas/content';
import type { VideoClip } from '@schemas/media';
import { supabaseConfigured } from '@/lib/supabase/client';
import { clipOf, imageRef, type ImageRef } from '@/lib/media/resolve';
import { parseRow, parseRows, reportLoadError } from './parse';
import { renderBody } from './portfolio';
import { contentClient } from './source';

// Runtime data access for the public services (Tier A SSR). Tenant + published
// filtering are enforced by RLS; we still pass status explicitly. Shape + validation live
// in `packages/schemas/content.ts` (CLAUDE.md §8 — one schema per shape, shared with the
// admin and Edge Functions). Resilient: returns []/null on any error (e.g. before Supabase
// is provisioned) so builds and the shell never break — pages render an empty state; the
// error CODE is logged (parse.ts reportLoadError).
//
// Round 2 (0028): a service also carries its discipline, the service-page fields (intro,
// value points, deliverables) and its poster + clip window. RLS hides a service whose
// discipline is not published (services_discipline_published), so an archived discipline
// takes its services off every list here without this file having to know.
//
//   getPublishedServices  the rows (home list, contact forms, sitemap, llms.txt,
//                         getPublishedDisciplines)
//   getServiceBySlug      one service for its page, with its body SOURCE and discipline
//   toServiceSummary / toServiceDetail   the camelCase view the Round 2 components render

export type { ServiceDetailRow, ServiceRow } from '@schemas/content';

const MEDIA = `(${PUBLIC_MEDIA_COLUMNS})`;

// Named columns, never `*`: the poster embed goes through the FK column, and a column the
// database does not have (a code-before-migration deploy) is a loud PGRST204 in the logs
// rather than a silent shape change.
export const SERVICE_COLUMNS =
  'id,slug,title,short_title,blurb,body_html,hero_video_uid,category,is_teaser,sort_order,' +
  'updated_at,discipline_id,intro,value_points,deliverables,preview_video_path,' +
  `preview_start_s,preview_end_s,poster:poster_media_id${MEDIA}`;

/** The page's select: the list columns, the Tiptap source and the discipline for the crumb. */
export const SERVICE_DETAIL_COLUMNS = `${SERVICE_COLUMNS},body,discipline:discipline_id(slug,name,sort_order)`;

/** A service as the Round 2 cards, explorer rows and form options render it. */
export interface ServiceSummary {
  id: string;
  slug: string;
  title: LocalizedText;
  /** The chip label: the short title where one exists, else the title. */
  label: LocalizedText;
  /** The tagline under the name (services.blurb): hero sub, meta description, list line. */
  tagline: LocalizedProse | null;
  /** The "What it is" heading line. */
  intro: LocalizedText | null;
  disciplineId: string | null;
  sortOrder: number;
  updatedAt: string | null;
  poster: ImageRef | null;
  /** The service's window of the showreel (EXC-009 until Stream, KAN-20). */
  clip: VideoClip | null;
}

/** Everything the service page renders from the service row itself. */
export interface ServiceDetail extends ServiceSummary {
  valuePoints: ValuePoint[];
  deliverables: LocalizedText[];
  /** Allowlist-rendered from the Tiptap source on every render (renderBody) — never body_html. */
  bodyHtml: LocalizedProse | null;
  /** The crumb's discipline; null only for a service not yet placed in one. */
  discipline: { slug: string; name: LocalizedText } | null;
}

export function toServiceSummary(row: ServiceRow): ServiceSummary {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    label: row.short_title ?? row.title,
    tagline: row.blurb,
    intro: row.intro,
    disciplineId: row.discipline_id,
    sortOrder: row.sort_order,
    updatedAt: row.updated_at,
    poster: imageRef(row.poster),
    clip: clipOf({
      uid: null,
      path: row.preview_video_path,
      startS: row.preview_start_s,
      endS: row.preview_end_s,
    }),
  };
}

export function toServiceDetail(row: ServiceDetailRow): ServiceDetail {
  return {
    ...toServiceSummary(row),
    valuePoints: row.value_points,
    deliverables: row.deliverables,
    bodyHtml: renderBody(row.body),
    discipline: row.discipline && { slug: row.discipline.slug, name: row.discipline.name },
  };
}

/**
 * The published service rows in sort_order, or null when the query failed — so a caller
 * that must not mistake an outage for "no services" (getPublishedDisciplines) can tell.
 */
export async function loadPublishedServiceRows(): Promise<ServiceRow[] | null> {
  if (!supabaseConfigured()) return null;
  try {
    const { data, error } = await contentClient()
      .from('services')
      .select(SERVICE_COLUMNS)
      .eq('status', 'published')
      .order('sort_order', { ascending: true });
    if (error) {
      reportLoadError('services', error);
      return null;
    }
    return parseRows(ServiceRowSchema, data ?? [], 'service');
  } catch (err) {
    reportLoadError('services', err);
    return null;
  }
}

export async function getPublishedServices(): Promise<ServiceRow[]> {
  return (await loadPublishedServiceRows()) ?? [];
}

/** One published service (row shape), or null — the page answers a real 404. */
export async function getServiceBySlug(slug: string): Promise<ServiceDetailRow | null> {
  if (!supabaseConfigured()) return null;
  try {
    const { data, error } = await contentClient()
      .from('services')
      .select(SERVICE_DETAIL_COLUMNS)
      .eq('status', 'published')
      .eq('slug', slug)
      .maybeSingle();
    if (error) {
      reportLoadError('service', error);
      return null;
    }
    if (!data) return null;
    return parseRow(ServiceDetailRowSchema, data, 'service');
  } catch (err) {
    reportLoadError('service', err);
    return null;
  }
}
