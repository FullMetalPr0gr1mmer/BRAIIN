import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext, Role } from '@/lib/auth/types';
import { can } from '@/lib/authz/matrix';
import { seoAccess } from './editorAccess';
import type { SeoAccess } from './editorTabs';

// What the Services and Projects screens (Admin v2 U5 + U6) decide on the server, from the
// same ROLE_CAPS the routes enforce, before their islands draw: which buttons a role is
// offered, which tabs it sees, and the one read the service editor's Leads tab makes. UX
// only: every route checks the capability again, and RLS decides every row.
//
//   services   services.write in full (Admin, Content Creator): add, edit, order, show or hide
//              a service or a discipline, and its case study (the case is services.write too);
//   archive    content.archiveDelete (Admin): Archived offered, Delete, and writing a row
//              that stays archived (the archive gates refuse it to anyone else, H12);
//   seo        seo.entityMeta: full (Admin, SEO), view (Content Creator), none;
//   leads      leads.manage (Admin, and Developer and Sales, who do not open these screens):
//              the "N leads" counts and the service editor's Leads tab;
//   portfolio  portfolio.write in full (Admin, Content Creator): add, edit and order projects,
//              and the clients in Manage tags (clients are portfolio.write, §5);
//   sectors    categories.manage in full (Admin, Content Creator): the sectors in Manage tags;
//   quotes     portfolio.write in full: the testimonial card's quotes (testimonials are
//              portfolio.write) and "Add a quote".

export interface ServicesAreaAccess {
  services: boolean;
  archive: boolean;
  seo: SeoAccess;
  leads: boolean;
  portfolio: boolean;
  sectors: boolean;
  quotes: boolean;
}

export function servicesAreaAccess(role: Role | undefined): ServicesAreaAccess {
  if (!role) {
    return {
      services: false,
      archive: false,
      seo: 'none',
      leads: false,
      portfolio: false,
      sectors: false,
      quotes: false,
    };
  }
  return {
    services: can(role, 'services.write') === 'full',
    archive: can(role, 'content.archiveDelete') === 'full',
    seo: seoAccess(role),
    leads: can(role, 'leads.manage') !== 'none',
    portfolio: can(role, 'portfolio.write') === 'full',
    sectors: can(role, 'categories.manage') === 'full',
    quotes: can(role, 'portfolio.write') === 'full',
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An `[id]` param that can be a row's id (anything else is a 404 before any read). */
export function isUuid(value: string | undefined | null): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/** One lead on a service's Leads tab: the safe columns only (never budget or contact). */
export interface ServiceLead {
  id: string;
  number: number | null;
  name: string;
  company: string | null;
  stage: { label: string; tone: string } | null;
  createdAt: string;
}

export interface ServiceLeads {
  rows: ServiceLead[];
  /** More than the tab shows exist. */
  more: boolean;
}

/** The most leads the tab lists; the leads screen has the rest. */
export const SERVICE_LEADS_SHOWN = 20;

/** The columns the tab reads: safe and pipeline columns (0033, 0034), nothing gated. */
export const SERVICE_LEAD_COLUMNS = 'id,lead_number,name,company,stage_id,created_at';

const STAGE_TONES = new Set(['klein', 'sky', 'ok', 'warn', 'err', 'gray']);

/**
 * The newest non-spam leads that named this service, as the caller reads them: the column
 * grant (0033) and the RESTRICTIVE live check decide, so a role without lead access, or a
 * stale token, reads none. Two reads (the leads, then their stages' words), each tenant-scoped.
 */
export async function loadServiceLeads(
  sb: SupabaseClient,
  auth: AuthContext,
  slug: string,
): Promise<ServiceLeads> {
  const { data, error } = await sb
    .from('leads')
    .select(SERVICE_LEAD_COLUMNS)
    .eq('tenant_id', auth.tenantId)
    .eq('is_spam', false)
    .eq('service_of_interest', slug)
    .order('created_at', { ascending: false })
    .limit(SERVICE_LEADS_SHOWN + 1);
  if (error) throw new Error(`service leads: ${error.code ?? error.message}`);
  const found = (data ?? []) as unknown as Record<string, unknown>[];
  const shown = found.slice(0, SERVICE_LEADS_SHOWN);
  const stageIds = [...new Set(shown.map((row) => row['stage_id']).filter(Boolean))] as string[];
  const stages = new Map<string, { label: string; tone: string }>();
  if (stageIds.length > 0) {
    const { data: rows, error: stageError } = await sb
      .from('lead_stages')
      .select('id,label,tone')
      .eq('tenant_id', auth.tenantId)
      .in('id', stageIds);
    if (stageError)
      throw new Error(`service lead stages: ${stageError.code ?? stageError.message}`);
    for (const stage of (rows ?? []) as Record<string, unknown>[]) {
      const tone = String(stage['tone']);
      stages.set(String(stage['id']), {
        label: String(stage['label']),
        tone: STAGE_TONES.has(tone) ? tone : 'gray',
      });
    }
  }
  return {
    rows: shown.map((row) => ({
      id: String(row['id']),
      number: typeof row['lead_number'] === 'number' ? row['lead_number'] : null,
      name: typeof row['name'] === 'string' ? row['name'] : '',
      company: typeof row['company'] === 'string' && row['company'] ? row['company'] : null,
      stage: stages.get(String(row['stage_id'])) ?? null,
      createdAt: String(row['created_at'] ?? ''),
    })),
    more: found.length > SERVICE_LEADS_SHOWN,
  };
}
