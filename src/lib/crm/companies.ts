import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { CompanyCreate, CompanyPatch, CompanyQuery } from '@schemas/crmCompanies';
import type { AuthContext } from '@/lib/auth/types';
import type { Capability } from '@/lib/authz/matrix';
import { AuthorizationError } from '@/lib/authz/errors';
import { constraintOf, type ConstraintFields } from '@/lib/admin/crud';
import { NotFoundError, OptimisticLockError, ValidationError } from '@/lib/admin/errors';

// The company routes' shared Worker half (Admin v2 C11, crm.md §5.3 and §9). The rules live in
// the database (the C11 migration: crm_companies, its triggers, the INVOKER readers and
// writers); this module names the fields every answer is cut to, turns the API's names into
// the database's, and translates a database refusal into the status the kernel maps. A
// company's answer never carries its domain index (no staff grant reads it), and a company's
// contacts are named only (never an e-mail or phone).

/** A company id from the path, or a 404 (never a 400: ids are not an oracle). */
export function requireCompanyId(params: Record<string, string | undefined>): string {
  const id = params['id'];
  if (!id || !z.string().uuid().safeParse(id).success) throw new NotFoundError('company');
  return id;
}

/** One company as the screens show it: what app.crm_company_json answers. */
export interface CompanyRow {
  id: string;
  name: string;
  website: string | null;
  size: string | null;
  city: string | null;
  stage: string;
  owner_id: string | null;
  notes: string | null;
  sector_id: string | null;
  sector_name: string | null;
  client_id: string | null;
  client_name: string | null;
  /** Made by the system from an inquiry (it goes with its last contact unless edited). */
  auto: boolean;
  /** Its contacts (not merged), derived. */
  contacts: number;
  /** The won leads' value over its contacts (SAR), derived. */
  won_value: number;
  version: number;
  created_at: string;
  updated_at: string;
}

/** The fields a company answer carries, and nothing else the database might add. */
export const COMPANY_FIELDS = [
  'id',
  'name',
  'website',
  'size',
  'city',
  'stage',
  'owner_id',
  'notes',
  'sector_id',
  'sector_name',
  'client_id',
  'client_name',
  'auto',
  'contacts',
  'won_value',
  'version',
  'created_at',
  'updated_at',
] as const satisfies readonly (keyof CompanyRow)[];

const STAGES: readonly string[] = ['lead', 'client', 'past', 'partner'];
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const num = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? value
    : typeof value === 'string' && /^\d+$/.test(value)
      ? Number(value)
      : 0;

/** One company from the database's JSON, cut to COMPANY_FIELDS; null when it is not one. */
export function pickCompany(value: unknown): CompanyRow | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const id = str(row['id']);
  const name = str(row['name']);
  if (!id || name === null || typeof row['version'] !== 'number') return null;
  const stage = str(row['stage']);
  return {
    id,
    name,
    website: str(row['website']),
    size: str(row['size']),
    city: str(row['city']),
    stage: stage && STAGES.includes(stage) ? stage : 'lead',
    owner_id: str(row['owner_id']),
    notes: str(row['notes']),
    sector_id: str(row['sector_id']),
    sector_name: str(row['sector_name']),
    client_id: str(row['client_id']),
    client_name: str(row['client_name']),
    auto: row['auto'] === true,
    contacts: num(row['contacts']),
    won_value: num(row['won_value']),
    version: row['version'],
    created_at: str(row['created_at']) ?? '',
    updated_at: str(row['updated_at']) ?? '',
  };
}

export interface CompanyPage {
  rows: CompanyRow[];
  total: number;
}

/** public.crm_companies_list's answer, cut to the named fields. */
export function parseCompanyList(data: unknown): CompanyPage {
  const body = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const rows = Array.isArray(body['rows']) ? body['rows'] : [];
  return {
    rows: rows.map(pickCompany).filter((row): row is CompanyRow => row !== null),
    total: num(body['total']),
  };
}

/** A company's contact as its drawer lists it: a name, a title and a stage, nothing else. */
export interface CompanyContact {
  id: string;
  display_name: string;
  title: string | null;
  stage: string;
}

/** public.crm_company_read's answer: the company, its first 50 contacts, and whether more. */
export function parseCompanyRead(data: unknown): {
  company: CompanyRow | null;
  contacts: CompanyContact[];
  more: boolean;
} {
  const body = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const contacts = Array.isArray(body['contacts']) ? body['contacts'] : [];
  return {
    company: pickCompany(body['company']),
    contacts: contacts.flatMap((value) => {
      if (!value || typeof value !== 'object') return [];
      const row = value as Record<string, unknown>;
      const id = str(row['id']);
      const name = str(row['display_name']);
      if (!id || name === null) return [];
      return [{ id, display_name: name, title: str(row['title']), stage: str(row['stage']) ?? 'lead' }];
    }),
    more: body['more'] === true,
  };
}

const COLUMNS: readonly [keyof CompanyCreate & keyof CompanyPatch, string][] = [
  ['name', 'name'],
  ['website', 'website'],
  ['sectorId', 'sector_id'],
  ['clientId', 'client_id'],
  ['size', 'size'],
  ['city', 'city'],
  ['stage', 'stage'],
  ['ownerId', 'owner_id'],
  ['notes', 'notes'],
];

/**
 * A company body in the database's names (app.crm_company_body_ok's keys). Absent stays
 * absent; an emptied text box is null (cleared). The version travels apart.
 */
export function companyBody(input: CompanyCreate | CompanyPatch): Record<string, string | null> {
  const body: Record<string, string | null> = {};
  const source = input as Record<string, unknown>;
  for (const [field, column] of COLUMNS) {
    const value = source[field];
    if (value === undefined) continue;
    body[column] = typeof value === 'string' && value.trim() === '' ? null : (value as string | null);
  }
  return body;
}

/** The fields a change touched, by the API's names (for the audit row; never their values). */
export function changedCompanyFields(input: CompanyPatch): string[] {
  return Object.entries(input)
    .filter(([field, value]) => field !== 'version' && value !== undefined)
    .map(([field]) => field)
    .sort();
}

/** The list's filter in the database's names (public.crm_companies_list). */
export function companyFilter(input: CompanyQuery): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  const q = input.q?.trim();
  if (q) filter['q'] = q;
  if (input.stage) filter['stage'] = input.stage;
  if (input.owner) filter['owner'] = input.owner;
  if (input.sort) filter['sort'] = input.sort;
  filter['limit'] = input.limit ?? 25;
  if (input.offset) filter['offset'] = input.offset;
  return filter;
}

/**
 * What a refused value means, by the constraint the database names (the owner rule and the
 * doors name one too). Copy follows the admin's rules (P-12): plain, no dashes.
 */
export const COMPANY_CONSTRAINTS: ConstraintFields = {
  crm_companies_owner_active: {
    field: 'ownerId',
    message: 'That person cannot own companies. Pick someone who works with contacts.',
  },
  crm_companies_owner_fk: {
    field: 'ownerId',
    message: 'That person cannot own companies. Pick someone who works with contacts.',
  },
  crm_companies_sector_fk: {
    field: 'sectorId',
    message: 'That sector is not there any more. Pick another one.',
  },
  crm_companies_client_fk: {
    field: 'clientId',
    message: 'That client is not there any more. Pick another one.',
  },
  crm_companies_name_check: { field: 'name', message: 'Give the company a name, in 120 characters.' },
  crm_companies_website_check: {
    field: 'website',
    message: 'Use an address that starts with https://, in 2048 characters.',
  },
  crm_companies_size_check: { field: 'size', message: 'Pick a size from the list.' },
  crm_companies_city_check: { field: 'city', message: 'Keep the city to 80 characters.' },
  crm_companies_stage_check: { field: 'stage', message: 'Pick a stage from the list.' },
  crm_companies_notes_check: { field: 'notes', message: 'Keep the notes to 2000 characters.' },
  crm_contacts_company_missing: {
    field: 'companyId',
    message: 'That company is not there any more. Pick another one.',
  },
  crm_contacts_company_fk: {
    field: 'companyId',
    message: 'That company is not there any more. Pick another one.',
  },
  crm_contacts_company_named: {
    message: 'This contact names no company yet. Type one under Details first.',
  },
};

interface DbError {
  code?: string;
  message?: string;
  details?: string | null;
}

/**
 * A database refusal of a company read or write, as the error the kernel maps: a bad value a
 * 422 naming its field, a moved version a 409, an unseen company (or contact) a 404, a refusal
 * by grant, policy or the live check a 403, anything else a 500 whose detail stays in
 * system_logs. Never the database's own text, which can quote values.
 */
export function companyError(
  error: DbError,
  what: string,
  entity: 'company' | 'contact' = 'company',
  cap: Capability = 'crm.contacts',
): Error {
  switch (error.code) {
    case 'P0002':
      return new NotFoundError(entity);
    case '40001':
      return new OptimisticLockError(entity === 'company' ? 'crm_companies' : 'crm_contacts');
    case '22023':
    case '22P02':
      return new ValidationError(`${what} was refused: check the values sent`);
    case '23503':
    case '23505':
    case '23514': {
      const known = COMPANY_CONSTRAINTS[constraintOf(error) ?? ''];
      return new ValidationError(known?.message ?? `${what} was refused`, known?.field);
    }
    case '42501':
      return new AuthorizationError(cap, `${what}: refused by the database`);
    default:
      return new Error(`${what}: ${error.code ?? 'no code'}`);
  }
}

/** One page of public.crm_companies_list as the caller (RLS and the live check decide). */
export async function readCompanyList(
  sb: SupabaseClient,
  tenantId: string,
  filter: Record<string, unknown>,
): Promise<CompanyPage> {
  const { data, error } = await sb.rpc('crm_companies_list', {
    p_tenant: tenantId,
    p_filter: filter,
  });
  if (error) throw companyError(error, 'the company list');
  return parseCompanyList(data);
}

/**
 * How many companies the caller's tenant holds (the People list's "· {n} companies"): one
 * HEAD count as the caller, null when it cannot be read.
 */
export async function readCompanyCount(
  sb: SupabaseClient,
  auth: AuthContext,
): Promise<number | null> {
  const { count, error } = await sb
    .from('crm_companies')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', auth.tenantId);
  return error || typeof count !== 'number' ? null : count;
}

/** A choice in the company drawer: a sector or a client, by its English name. */
export interface CompanyOption {
  id: string;
  name: string;
}

function options(data: unknown): CompanyOption[] {
  if (!Array.isArray(data)) return [];
  return data
    .flatMap((row: Record<string, unknown>) => {
      const id = str(row['id']);
      const name = row['name'] as { en?: unknown } | null;
      const label = typeof name?.en === 'string' && name.en.trim() ? name.en.trim() : null;
      return id && label ? [{ id, name: label }] : [];
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

/**
 * The drawer's choices, read as the caller: the tenant's sectors and its public clients rows
 * (a link only: linking publishes nothing, clients.visible stays portfolio's switch). A role
 * that reads neither gets empty lists; the database's keys refuse anything else.
 */
export async function readCompanyOptions(
  sb: SupabaseClient,
  auth: AuthContext,
): Promise<{ sectors: CompanyOption[]; clients: CompanyOption[] }> {
  const [sectors, clients] = await Promise.all([
    sb.from('sectors').select('id,name').eq('tenant_id', auth.tenantId).limit(200),
    sb.from('clients').select('id,name').eq('tenant_id', auth.tenantId).limit(500),
  ]);
  return {
    sectors: sectors.error ? [] : options(sectors.data),
    clients: clients.error ? [] : options(clients.data),
  };
}
