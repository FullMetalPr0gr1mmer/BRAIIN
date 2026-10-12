import type { LeadBulkAction, LeadPatch } from '@schemas/crm';
import { AuthorizationError } from '@/lib/authz/errors';
import { constraintOf, type ConstraintFields } from '@/lib/admin/crud';
import { ValidationError } from '@/lib/admin/errors';

// The write side of the leads API (Admin v2 C3): what a PATCH or a bulk change writes, and
// what a database refusal means to the person who sent it. The rules themselves live in the
// database (migration 0041: the staff column grant, the CHECKs, the assignee rule and the
// bulk door), so a direct API call is held to them too; this module only translates.

/**
 * What a refused value means, by the constraint the database names. The assignee rule is a
 * trigger, not a constraint, so its message names `leads_assignee_active` for this map.
 * Copy follows the admin's rules (P-12): plain, no dashes.
 */
export const LEAD_CONSTRAINTS: ConstraintFields = {
  leads_stage_fk: { field: 'stageId', message: 'That stage is not part of this pipeline.' },
  leads_assignee_fk: {
    field: 'assignedTo',
    message: 'That person cannot be given leads. Pick someone who works leads.',
  },
  leads_assignee_active: {
    field: 'assignedTo',
    message: 'That person cannot be given leads. Pick someone who works leads.',
  },
  leads_value_sar_range: {
    field: 'valueSar',
    message: 'A value is a whole number of riyals, from 0 to 10,000,000.',
  },
  leads_tags_ok: {
    field: 'tags',
    message: 'A lead has up to 10 tags, each 1 to 32 characters and used once.',
  },
  leads_last_contact_channel_ok: {
    field: 'logContact',
    message: 'Pick how you were in touch: call, e-mail, WhatsApp, meeting or other.',
  },
};

interface DbError {
  code?: string;
  message?: string;
  details?: string | null;
}

/**
 * A database refusal of a lead write, as the error the admin kernel maps to a status:
 * a bad value is a 422 naming its field, a refusal by grant or policy is a 403, anything
 * else a 500 whose detail stays in system_logs. Never the database's own text, which can
 * quote values.
 */
export function leadWriteError(error: DbError, what: string): Error {
  switch (error.code) {
    case '22023':
      return new ValidationError(`${what} was refused: check the values sent`);
    case '23503':
    case '23514': {
      const known = LEAD_CONSTRAINTS[constraintOf(error) ?? ''];
      return new ValidationError(known?.message ?? `${what} was refused`, known?.field);
    }
    case '42501':
      return new AuthorizationError('leads.manage', `${what}: refused by the database`);
    default:
      return new Error(`${what}: ${error.code ?? 'no code'}`);
  }
}

/** The leads columns a PATCH writes, from what was sent. `now` is the Worker's clock. */
export function leadPatchValues(patch: LeadPatch, now: Date): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  // The pipeline: versioned (the database moves the version, and a stale one is a 409).
  if (patch.stageId !== undefined) values['stage_id'] = patch.stageId;
  if (patch.isSpam !== undefined) values['is_spam'] = patch.isSpam;
  if (patch.assignedTo !== undefined) values['assigned_to'] = patch.assignedTo;
  if (patch.valueSar !== undefined) values['value_sar'] = patch.valueSar;
  if (patch.tags !== undefined) values['tags'] = patch.tags;
  // The marks: unversioned. The database keeps the first look, stamps both with its own
  // clock and the session's person; what is sent here only says "now" or "clear".
  if (patch.isStarred !== undefined) values['is_starred'] = patch.isStarred;
  if (patch.read !== undefined) values['read_at'] = patch.read ? now.toISOString() : null;
  if (patch.logContact !== undefined) {
    values['last_contact_channel'] = patch.logContact.channel;
    values['last_contact_at'] = now.toISOString();
  }
  // The legacy panel's two fields (the expand window; C4 and C14 retire them).
  if (patch.status !== undefined) values['status'] = patch.status;
  if (patch.internalNotes !== undefined) values['internal_notes'] = patch.internalNotes;
  return values;
}

/** The column each bulk action writes (for the per-lead audit row). */
export const BULK_ACTION_FIELD: Readonly<Record<LeadBulkAction, string>> = {
  assign: 'assigned_to',
  stage: 'stage_id',
  spam: 'is_spam',
  read: 'read_at',
  star: 'is_starred',
  tagAdd: 'tags',
  tagRemove: 'tags',
};

export type BulkOutcome = 'applied' | 'conflict' | 'missing' | 'skipped';

export interface BulkRow {
  id: string;
  version: number | null;
  outcome: BulkOutcome;
}

const OUTCOMES = new Set<string>(['applied', 'conflict', 'missing', 'skipped']);

/** public.leads_bulk_update's rows, checked: anything else it answered is dropped. */
export function parseBulkRows(data: unknown): BulkRow[] {
  if (!Array.isArray(data)) return [];
  const rows: BulkRow[] = [];
  for (const raw of data as Record<string, unknown>[]) {
    const id = raw['lead_id'];
    const outcome = raw['outcome'];
    if (typeof id !== 'string' || typeof outcome !== 'string' || !OUTCOMES.has(outcome)) continue;
    const version = raw['lead_version'];
    rows.push({
      id,
      version: typeof version === 'number' ? version : null,
      outcome: outcome as BulkOutcome,
    });
  }
  return rows;
}
