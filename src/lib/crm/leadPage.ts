import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '@/lib/auth/types';
import type { BadgeTone } from '@/lib/admin/tones';
import { getRow } from '@/lib/admin/crud';
import { writeAudit } from '@/lib/admin/audit';
import { LEAD_WRITE_COLUMNS, stripSensitive } from '@/lib/admin/leadFields';
import { resolveLeadInterests, withInterestLabels } from '@/lib/leads/interestLabel';
import {
  readLeadBoard,
  readLeadList,
  readLeadSummary,
  type BoardColumn,
  type LeadPage,
  type LeadSummaryAnswer,
} from './leadReads';
import {
  boardQueryOf,
  listQueryOf,
  neighboursQueryOf,
  summaryQueryOf,
  type LeadFilters,
} from './leadUrl';
import { stageTone, type LeadEvent } from './leadView';

// The leads pages' server render (Admin v2 C4b): what /admin/leads, /admin/leads/board and
// /admin/leads/[id] read before their islands hydrate, so each page is complete without
// JavaScript and the island starts from it. The page has already refused any role without
// `leads.manage` (and read nothing then); everything here runs as the caller, for the
// caller's tenant, so RLS, the live check and the column grants decide again.
//
// What a page reads (P-15: the Workers Free plan's 50 subrequests and 10 ms of CPU), each a
// count of round trips on top of the layout's shell:
//   list     frame 4 (stages, people, disciplines, services) + summary 1, 2 when ranged
//            + list 1 + its interest labels up to 2               = 8, 9 ranged
//   board    frame 4 + board 1 + its labels up to 2               = 7
//   detail   stages, people, the lead, its labels up to 2, the neighbours, the first events,
//            the service's id (services.write holders), the view's audit row = 9
// Never a gated column, a note, a score reason or a decrypted value: the contact details and
// the notes are read by the island, through the audited routes, and only on request.

/** A pipeline stage as the screens draw it. */
export interface StageView {
  id: string;
  key: string;
  label: string;
  tone: BadgeTone;
  kind: 'open' | 'won' | 'lost';
  isInitial: boolean;
}

/** Someone a lead can be assigned to (public.crm_people: active lead workers). */
export interface PersonView {
  id: string;
  name: string;
}

/** A published discipline (the list's filter) with its published services (the drawer). */
export interface DisciplineView {
  slug: string;
  name: string;
  services: { slug: string; name: string }[];
}

export interface LeadsFrame {
  stages: StageView[];
  people: PersonView[];
  disciplines: DisciplineView[];
}

/** The first view of the list: the KPIs and chips for the range, and page 1. */
export interface LeadsListInitial {
  summary: LeadSummaryAnswer | null;
  page: LeadPage | null;
}

/** The detail page's lead: the safe columns, the pipeline's, and the interest labels. */
export type LeadDetailRow = Record<string, unknown> & {
  id: string;
  version: number;
  service_label?: { en: string; ar: string };
  discipline_label?: { en: string; ar: string };
};

export interface LeadEventRow extends LeadEvent {
  id: number;
  at: string;
}

export interface LeadDetailInitial {
  lead: LeadDetailRow;
  neighbours: { prev: string | null; next: string | null };
  events: LeadEventRow[];
  /** Where "Load older" picks up, or null when the first page held them all. */
  before: { at: string; id: number } | null;
  /** The service editor's address, for services.write holders when the service exists. */
  serviceHref: string | null;
}

/** The first page of a lead's timeline (GET /api/admin/leads/[id]/events reads on). */
export const EVENTS_PAGE = 50;

const KINDS = new Set(['open', 'won', 'lost']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function en(value: unknown): string {
  return value && typeof value === 'object' ? text((value as Record<string, unknown>)['en']) : '';
}

/** The tenant's stages, in board order. */
export async function readStages(sb: SupabaseClient, auth: AuthContext): Promise<StageView[]> {
  const { data, error } = await sb
    .from('lead_stages')
    .select('id,key,label,tone,kind,is_initial,sort_order')
    .eq('tenant_id', auth.tenantId)
    .order('sort_order', { ascending: true });
  if (error) throw new Error(`lead stages: ${error.message}`);
  return ((data ?? []) as Record<string, unknown>[]).flatMap((row) =>
    typeof row['id'] === 'string' && typeof row['key'] === 'string'
      ? [
          {
            id: row['id'],
            key: row['key'],
            label: text(row['label']) || row['key'],
            tone: stageTone(row),
            kind: (KINDS.has(String(row['kind'])) ? row['kind'] : 'open') as StageView['kind'],
            isInitial: row['is_initial'] === true,
          },
        ]
      : [],
  );
}

/** The people a lead can be assigned to; empty when the directory cannot be read. */
export async function readPeople(sb: SupabaseClient, auth: AuthContext): Promise<PersonView[]> {
  const { data, error } = await sb.rpc('crm_people', { p_tenant: auth.tenantId });
  if (error || !Array.isArray(data)) return [];
  return (data as Record<string, unknown>[]).flatMap((person) =>
    typeof person['id'] === 'string'
      ? [{ id: person['id'], name: text(person['display_name']) || 'A member with no name' }]
      : [],
  );
}

/** The published disciplines and their published services, in the site's order. */
async function readDisciplines(sb: SupabaseClient, auth: AuthContext): Promise<DisciplineView[]> {
  const [disciplines, services] = await Promise.all([
    sb
      .from('disciplines')
      .select('id,slug,name,sort_order')
      .eq('tenant_id', auth.tenantId)
      .eq('status', 'published')
      .order('sort_order', { ascending: true }),
    sb
      .from('services')
      .select('slug,title,discipline_id,sort_order')
      .eq('tenant_id', auth.tenantId)
      .eq('status', 'published')
      .order('sort_order', { ascending: true }),
  ]);
  if (disciplines.error || !Array.isArray(disciplines.data)) return [];
  const byDiscipline = new Map<string, { slug: string; name: string }[]>();
  for (const row of (services.error ? [] : (services.data ?? [])) as Record<string, unknown>[]) {
    const id = row['discipline_id'];
    if (typeof id !== 'string' || typeof row['slug'] !== 'string') continue;
    const list = byDiscipline.get(id) ?? [];
    list.push({ slug: row['slug'], name: en(row['title']) || row['slug'] });
    byDiscipline.set(id, list);
  }
  return (disciplines.data as Record<string, unknown>[]).flatMap((row) =>
    typeof row['slug'] === 'string' && typeof row['id'] === 'string'
      ? [
          {
            slug: row['slug'],
            name: en(row['name']) || row['slug'],
            services: byDiscipline.get(row['id']) ?? [],
          },
        ]
      : [],
  );
}

/** What every leads page needs to draw a lead: the stages, the people, the disciplines. */
export async function readLeadsFrame(sb: SupabaseClient, auth: AuthContext): Promise<LeadsFrame> {
  const [stages, people, disciplines] = await Promise.all([
    readStages(sb, auth),
    readPeople(sb, auth),
    readDisciplines(sb, auth),
  ]);
  return { stages, people, disciplines };
}

/**
 * The list's first view: the KPIs for the range and the first page for the address's filters.
 * Each half fails on its own (null): the island says so and tries again on its first read.
 */
export async function readLeadsListInitial(
  sb: SupabaseClient,
  auth: AuthContext,
  filters: LeadFilters,
  now: Date,
): Promise<LeadsListInitial> {
  const [summary, page] = await Promise.all([
    readLeadSummary(sb, auth.tenantId, summaryQueryOf(filters, now)).catch(() => null),
    readLeadList(sb, auth.tenantId, listQueryOf(filters, now)).catch(() => null),
  ]);
  return { summary, page };
}

/** The board's first view for the address's filters (no search: the island posts that). */
export async function readBoardInitial(
  sb: SupabaseClient,
  auth: AuthContext,
  filters: LeadFilters,
  now: Date,
): Promise<BoardColumn[] | null> {
  const { perStage, ...rest } = boardQueryOf(filters, now);
  return readLeadBoard(sb, auth.tenantId, { ...rest, per_stage: perStage }).catch(() => null);
}

/** Previous and Next in the list's order and filter (public.lead_neighbours, decision D8). */
async function readNeighbours(
  sb: SupabaseClient,
  auth: AuthContext,
  id: string,
  filters: LeadFilters,
  now: Date,
): Promise<{ prev: string | null; next: string | null }> {
  const { data, error } = await sb.rpc('lead_neighbours', {
    p_tenant: auth.tenantId,
    p_id: id,
    p_filter: neighboursQueryOf(filters, now),
  });
  const pickId = (value: unknown) => (typeof value === 'string' && UUID.test(value) ? value : null);
  if (error || !data || typeof data !== 'object') return { prev: null, next: null };
  const answer = data as Record<string, unknown>;
  return { prev: pickId(answer['prev']), next: pickId(answer['next']) };
}

/** The newest events of a lead, as GET /api/admin/leads/[id]/events reads them. */
async function readFirstEvents(
  sb: SupabaseClient,
  auth: AuthContext,
  id: string,
): Promise<{ events: LeadEventRow[]; before: LeadDetailInitial['before'] }> {
  const { data, error } = await sb
    .from('lead_events')
    .select('id,at,actor_id,kind,detail')
    .eq('tenant_id', auth.tenantId)
    .eq('lead_id', id)
    .order('at', { ascending: false })
    .order('id', { ascending: false })
    .limit(EVENTS_PAGE);
  if (error || !Array.isArray(data)) return { events: [], before: null };
  const events = data as LeadEventRow[];
  const last = events.length === EVENTS_PAGE ? events.at(-1) : undefined;
  return { events, before: last ? { at: last.at, id: last.id } : null };
}

/** The service editor's address for a service slug, or null. */
async function readServiceHref(
  sb: SupabaseClient,
  auth: AuthContext,
  slug: unknown,
): Promise<string | null> {
  if (typeof slug !== 'string' || slug === '') return null;
  const { data, error } = await sb
    .from('services')
    .select('id')
    .eq('tenant_id', auth.tenantId)
    .eq('slug', slug)
    .maybeSingle<{ id: string }>();
  return !error && data && UUID.test(data.id) ? `/admin/services/${data.id}` : null;
}

/**
 * One lead for its page: the row (safe and pipeline columns: getRow throws NotFoundError for
 * a lead the caller cannot see, the same answer as one that does not exist), its labels, its
 * neighbours in the address's filter, the first page of its timeline and, for a services.write
 * holder, its service's editor. The view is audited as GET /api/admin/leads/[id] audits it
 * (`lead.view`, no personal data); the row is read first, so an unseen lead writes nothing.
 */
export async function readLeadDetail(
  sb: SupabaseClient,
  auth: AuthContext,
  id: string,
  filters: LeadFilters,
  now: Date,
  canEditServices: boolean,
): Promise<LeadDetailInitial> {
  const row = await getRow<Record<string, unknown>>(sb, 'leads', auth, id, LEAD_WRITE_COLUMNS);
  const [labels, neighbours, first, serviceHref] = await Promise.all([
    resolveLeadInterests(sb, auth.tenantId, [row]),
    readNeighbours(sb, auth, id, filters, now),
    readFirstEvents(sb, auth, id),
    canEditServices ? readServiceHref(sb, auth, row['service_of_interest']) : null,
    writeAudit(sb, auth, {
      action: 'lead.view',
      entityType: 'lead',
      entityId: id,
      detail: { pii: false, via: 'page' },
    }),
  ]);
  const lead = withInterestLabels(stripSensitive(row), labels) as LeadDetailRow;
  return { lead, neighbours, events: first.events, before: first.before, serviceHref };
}
