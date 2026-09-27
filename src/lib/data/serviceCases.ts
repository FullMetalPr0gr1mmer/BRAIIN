import {
  PUBLIC_MEDIA_COLUMNS,
  ServiceCaseRowSchema,
  type CaseProblem,
  type LocalizedText,
  type ResultCard,
  type ServiceCaseRow,
} from '@schemas/content';
import { anonClient, supabaseConfigured } from '@/lib/supabase/client';
import { imageRef, type ImageRef } from '@/lib/media/resolve';
import { parseRow, reportLoadError } from './parse';
import type { FacetValue } from './portfolio';

// A service page's case block (0028 service_cases, one per service). Tier A SSR under
// RLS: a case is public only while it AND its service are published
// (service_cases_published_parent); its project arrives embedded through portfolio_id
// under anon's own portfolio RLS (published only), and the project's client through the
// project's client_id under the clients' disclosure rule (`visible`).
//
// The client and sector ARE the project's — the case has no columns of its own for them,
// so the block can never name a client the project does not.
//
// The anon grant on service_cases is COLUMN-level (is_placeholder, version, the actors
// and scheduled_for are withheld), so the select names its columns.

const MEDIA = `(${PUBLIC_MEDIA_COLUMNS})`;

export const SERVICE_CASE_COLUMNS =
  'id,service_id,portfolio_id,title,context,problems,results,updated_at,' +
  `project:portfolio_id(id,slug,title,client_id,poster:poster_media_id${MEDIA},` +
  'sector:sector_id(slug,name,sort_order),client:client_id(slug,name,sort_order))';

export interface ServiceCaseProject {
  slug: string;
  title: LocalizedText;
  poster: ImageRef | null;
  sector: FacetValue | null;
  /** null with `confidentialClient` = a client we may not name (hidden by RLS). */
  client: FacetValue | null;
  confidentialClient: boolean;
}

export interface ServiceCase {
  id: string;
  serviceId: string;
  title: LocalizedText;
  /** "Where they were". */
  context: LocalizedText | null;
  /** Problem → what we did, in order. */
  problems: CaseProblem[];
  results: ResultCard[];
  updatedAt: string | null;
  /** null: no project, or one that is not published (the block then has no project link). */
  project: ServiceCaseProject | null;
}

export function toServiceCase(row: ServiceCaseRow): ServiceCase {
  const p = row.project;
  return {
    id: row.id,
    serviceId: row.service_id,
    title: row.title,
    context: row.context,
    problems: row.problems,
    results: row.results,
    updatedAt: row.updated_at,
    project: p && {
      slug: p.slug,
      title: p.title,
      poster: imageRef(p.poster),
      sector: p.sector && { slug: p.sector.slug, name: p.sector.name, order: p.sector.sort_order },
      client: p.client && { slug: p.client.slug, name: p.client.name, order: p.client.sort_order },
      confidentialClient: p.client_id !== null && p.client === null,
    },
  };
}

/** The published case of a service, or null (none, unpublished, or its service is). */
export async function getServiceCase(serviceId: string): Promise<ServiceCase | null> {
  if (!supabaseConfigured()) return null;
  try {
    const { data, error } = await anonClient()
      .from('service_cases')
      .select(SERVICE_CASE_COLUMNS)
      .eq('status', 'published')
      .eq('service_id', serviceId)
      .maybeSingle();
    if (error) {
      reportLoadError('service_case', error);
      return null;
    }
    if (!data) return null;
    const row = parseRow(ServiceCaseRowSchema, data, 'service_case');
    return row ? toServiceCase(row) : null;
  } catch (err) {
    reportLoadError('service_case', err);
    return null;
  }
}
