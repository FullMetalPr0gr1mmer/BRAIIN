import type { SupabaseClient } from '@supabase/supabase-js';
import {
  TEAM_NOTE_MESSAGES,
  TEAM_NOTES_RETENTION_DAYS,
  type TeamNoteProblem,
} from '@schemas/dashboard';
import type { AuthContext } from '@/lib/auth/types';
import { AuthorizationError } from '@/lib/authz/errors';
import { OptimisticLockError, ValidationError } from '../errors';

// The team notes (Admin v2 U1, README U1 D4 to D6): one shared note per tenant, read by every
// holder of analytics.read and written only through public.save_team_notes() (0060), which
// checks the live role itself, takes the version, applies the rules again and writes the
// audit row (the length only) in the same transaction. Read and saved through the caller's
// RLS-bound client.

export interface TeamNotes {
  body: string;
  /** 0 when the tenant never saved one (no row). */
  version: number;
  /** When it was last saved or cleared (ISO), or null. */
  updatedAt: string | null;
  /** The rule's days: shown under the note. */
  retentionDays: number;
}

interface NoteRow {
  body: string | null;
  version: number | null;
  updated_at: string | null;
}

export async function readTeamNotes(sb: SupabaseClient, auth: AuthContext): Promise<TeamNotes> {
  const { data, error } = await sb
    .from('team_notes')
    .select('body,version,updated_at')
    .eq('tenant_id', auth.tenantId)
    .maybeSingle<NoteRow>();
  if (error) throw new Error(`team notes: ${error.code ?? error.message}`);
  return {
    body: typeof data?.body === 'string' ? data.body : '',
    version: typeof data?.version === 'number' ? data.version : 0,
    updatedAt: data?.updated_at ?? null,
    retentionDays: TEAM_NOTES_RETENTION_DAYS,
  };
}

const PROBLEMS = new Set<string>(Object.keys(TEAM_NOTE_MESSAGES));

/**
 * Saves the note under the version the person read. The definer's refusals become the
 * route's answers: 42501 a 403, 40001 a 409, 22023 a 422 on the field with the rule's own
 * sentence (the Worker's schema refused the same text first, so this is a direct call's
 * answer or a rule the two disagree on).
 */
export async function saveTeamNotes(
  sb: SupabaseClient,
  auth: AuthContext,
  body: string,
  version: number,
): Promise<TeamNotes> {
  const { data, error } = await sb.rpc('save_team_notes', {
    p_tenant: auth.tenantId,
    p_body: body,
    p_version: version,
  });
  if (error) {
    if (error.code === '42501') throw new AuthorizationError('analytics.read', 'the database refused the save (live check)');
    if (error.code === '40001') throw new OptimisticLockError('team_notes');
    if (error.code === '22023') {
      const problem = PROBLEMS.has(error.message) ? (error.message as TeamNoteProblem) : null;
      throw new ValidationError(
        problem ? TEAM_NOTE_MESSAGES[problem] : 'That note cannot be saved.',
        'body',
      );
    }
    throw new Error(`save team notes: ${error.code ?? error.message}`);
  }
  const saved = (data ?? {}) as { version?: unknown; updated_at?: unknown };
  return {
    body,
    version: typeof saved.version === 'number' ? saved.version : version + 1,
    updatedAt: typeof saved.updated_at === 'string' ? saved.updated_at : null,
    retentionDays: TEAM_NOTES_RETENTION_DAYS,
  };
}
