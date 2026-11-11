import { z } from 'zod';
import type { TaskCreate, TaskPatch, TaskType } from '@schemas/crmTasks';
import type { Capability } from '@/lib/authz/matrix';
import { AuthorizationError } from '@/lib/authz/errors';
import { constraintOf, type ConstraintFields } from '@/lib/admin/crud';
import { NotFoundError, OptimisticLockError, ValidationError } from '@/lib/admin/errors';

// The task routes' shared Worker half (Admin v2 C8, crm.md §9). The rules live in the database
// (0134: the table, its triggers, the INVOKER readers and writers, the studio's zone); this
// module names the fields every answer is cut to, turns the API's names into the database's,
// and translates a database refusal into the status the kernel maps. A task names its contact
// and its lead by name only: never a contact detail (crm.md §11, PII rules).

/** A task id from the path, or a 404 (never a 400: ids are not an oracle). */
export function requireTaskId(params: Record<string, string | undefined>): string {
  const id = params['id'];
  if (!id || !z.string().uuid().safeParse(id).success) throw new NotFoundError('task');
  return id;
}

/** One task as the screens show it: what public.crm_tasks_grouped and the doors answer. */
export interface TaskRow {
  id: string;
  title: string;
  type: TaskType;
  note: string | null;
  due_at: string;
  /** The due moment's local date and clock time in the studio's zone (YYYY-MM-DD, HH:MM). */
  due_date: string;
  due_time: string;
  done_at: string | null;
  owner_id: string | null;
  contact_id: string | null;
  contact_name: string | null;
  contact_company: string | null;
  lead_id: string | null;
  lead_number: number | null;
  lead_name: string | null;
  version: number;
  created_at: string;
}

/** The fields a task answer carries, and nothing else the database might add. */
export const TASK_FIELDS = [
  'id',
  'title',
  'type',
  'note',
  'due_at',
  'due_date',
  'due_time',
  'done_at',
  'owner_id',
  'contact_id',
  'contact_name',
  'contact_company',
  'lead_id',
  'lead_number',
  'lead_name',
  'version',
  'created_at',
] as const satisfies readonly (keyof TaskRow)[];

const TYPES: readonly string[] = ['call', 'email', 'whatsapp', 'meeting', 'todo'];
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** One task from the database's JSON, cut to TASK_FIELDS; null when it is not one. */
export function pickTask(value: unknown): TaskRow | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const id = str(row['id']);
  const title = str(row['title']);
  const dueAt = str(row['due_at']);
  if (!id || title === null || !dueAt || typeof row['version'] !== 'number') return null;
  const type = str(row['type']);
  return {
    id,
    title,
    type: (type && TYPES.includes(type) ? type : 'todo') as TaskType,
    note: str(row['note']),
    due_at: dueAt,
    due_date: str(row['due_date']) ?? '',
    due_time: str(row['due_time']) ?? '',
    done_at: str(row['done_at']),
    owner_id: str(row['owner_id']),
    contact_id: str(row['contact_id']),
    contact_name: str(row['contact_name']),
    contact_company: str(row['contact_company']),
    lead_id: str(row['lead_id']),
    lead_number: typeof row['lead_number'] === 'number' ? row['lead_number'] : null,
    lead_name: str(row['lead_name']),
    version: row['version'],
    created_at: str(row['created_at']) ?? '',
  };
}

const rows = (value: unknown): TaskRow[] =>
  Array.isArray(value) ? value.map(pickTask).filter((row): row is TaskRow => row !== null) : [];
const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

/** The Tasks screen's data: the lists, their whole counts, and the studio's day. */
export interface TaskGroups {
  tz: string;
  now: string;
  /** Today's local date in the studio's zone (YYYY-MM-DD): the drawer's default due date. */
  today: string;
  counts: { overdue: number; today: number; upcoming: number; done: number };
  /** The caller's own open tasks, whatever the filter (the screen's fallback to Everyone). */
  mineOpen: number;
  overdue: TaskRow[];
  dueToday: TaskRow[];
  upcoming: TaskRow[];
  done: TaskRow[];
}

/** public.crm_tasks_grouped's answer, cut to the named fields. */
export function parseGroups(data: unknown): TaskGroups {
  const g = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const c = (g['counts'] && typeof g['counts'] === 'object' ? g['counts'] : {}) as Record<
    string,
    unknown
  >;
  return {
    tz: str(g['tz']) ?? '',
    now: str(g['now']) ?? '',
    today: str(g['today']) ?? '',
    counts: {
      overdue: count(c['overdue']),
      today: count(c['today']),
      upcoming: count(c['upcoming']),
      done: count(c['done']),
    },
    mineOpen: count(g['mine_open']),
    overdue: rows(g['overdue']),
    dueToday: rows(g['today_tasks']),
    upcoming: rows(g['upcoming']),
    done: rows(g['done']),
  };
}

/** A new task in the database's names (app.crm_task_input). Absent stays absent. */
export function createBody(input: TaskCreate): Record<string, unknown> {
  const body: Record<string, unknown> = {
    title: input.title,
    due_date: input.dueDate,
    due_time: input.dueTime,
  };
  if (input.type !== undefined) body['type'] = input.type;
  if (input.contactId !== undefined) body['contact_id'] = input.contactId;
  if (input.leadId !== undefined) body['lead_id'] = input.leadId;
  if (input.ownerId !== undefined) body['owner_id'] = input.ownerId;
  if (input.note !== undefined) body['note'] = input.note === '' ? null : input.note;
  return body;
}

/** A change in the database's names. The version travels apart (p_version). */
export function patchBody(input: TaskPatch): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.title !== undefined) body['title'] = input.title;
  if (input.type !== undefined) body['type'] = input.type;
  if (input.dueDate !== undefined) body['due_date'] = input.dueDate;
  if (input.dueTime !== undefined) body['due_time'] = input.dueTime;
  if (input.contactId !== undefined) body['contact_id'] = input.contactId;
  if (input.leadId !== undefined) body['lead_id'] = input.leadId;
  if (input.ownerId !== undefined) body['owner_id'] = input.ownerId;
  if (input.note !== undefined) body['note'] = input.note === '' ? null : input.note;
  if (input.done !== undefined) body['done'] = input.done;
  if (input.snooze !== undefined) body['snooze'] = input.snooze;
  return body;
}

/**
 * What a refused value means, by the constraint the database names (the triggers' and the
 * doors' messages name one too). Copy follows the admin's rules (P-12): plain, no dashes.
 */
export const TASK_CONSTRAINTS: ConstraintFields = {
  crm_tasks_owner_active: {
    field: 'ownerId',
    message: 'That person cannot own tasks. Pick someone who works with tasks.',
  },
  crm_tasks_owner_fk: {
    field: 'ownerId',
    message: 'That person cannot own tasks. Pick someone who works with tasks.',
  },
  crm_tasks_contact_live: {
    field: 'contactId',
    message: 'That contact was merged into another one. Pick the one it was merged into.',
  },
  crm_tasks_link_missing: {
    message: 'That contact or lead is not there any more. Pick another one.',
  },
  crm_tasks_contact_fk: {
    field: 'contactId',
    message: 'That contact is not there any more. Pick another one.',
  },
  crm_tasks_lead_fk: {
    field: 'leadId',
    message: 'That lead is not there any more. Pick another one.',
  },
  crm_tasks_title_check: { field: 'title', message: 'Say what needs doing, in 200 characters.' },
  crm_tasks_note_check: { field: 'note', message: 'Keep the note to 2000 characters.' },
  crm_tasks_type_check: { field: 'type', message: 'Pick a type from the list.' },
  crm_tasks_due_at_check: { field: 'dueDate', message: 'Pick a date between 2000 and 2100.' },
};

interface DbError {
  code?: string;
  message?: string;
  details?: string | null;
}

/**
 * A database refusal of a task read or write, as the error the kernel maps: a bad value a 422
 * naming its field, a moved version a 409, an unseen task a 404, a refusal by grant, policy or
 * the live check a 403, anything else a 500 whose detail stays in system_logs. Never the
 * database's own text, which can quote values.
 */
export function taskError(error: DbError, what: string, cap: Capability = 'crm.tasks'): Error {
  switch (error.code) {
    case 'P0002':
      return new NotFoundError('task');
    case '40001':
      return new OptimisticLockError('crm_tasks');
    case '22023':
    case '22P02':
    case '22007':
    case '22008':
      return new ValidationError(`${what} was refused: check the values sent`);
    case '23503':
    case '23505':
    case '23514': {
      const known = TASK_CONSTRAINTS[constraintOf(error) ?? ''];
      return new ValidationError(known?.message ?? `${what} was refused`, known?.field);
    }
    case '42501':
      return new AuthorizationError(cap, `${what}: refused by the database`);
    default:
      return new Error(`${what}: ${error.code ?? 'no code'}`);
  }
}

/** The fields a change touched, by the API's names (for the audit row; never their values). */
export function changedFields(input: TaskPatch): string[] {
  return Object.entries(input)
    .filter(([field, value]) => field !== 'version' && value !== undefined)
    .map(([field]) => field)
    .sort();
}
