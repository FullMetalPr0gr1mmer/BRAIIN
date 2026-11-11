import { z } from 'zod';

// CRM tasks (Admin v2 C8, crm.md §5.4 and §9): the shapes the task routes accept. A module of
// its own beside crm.ts (the leads and contacts), so the two lanes' edits never meet. The
// database checks the same rules again (0134: the column CHECKs, the owner and tombstone rules
// in app.tg_crm_task_row, the allow-list in app.crm_task_input): two layers, and a 22023 or
// 23514 for anything outside them. Dates and times are the studio's local ones; the database
// turns them into instants in the studio's zone (site_settings.timezone), never the browser.

/** What kind of follow-up a task is (crm_tasks.type). */
export const TASK_TYPES = ['call', 'email', 'whatsapp', 'meeting', 'todo'] as const;
export type TaskType = (typeof TASK_TYPES)[number];

/** Whose tasks the list shows: the caller's own, or everyone's. */
export const TASK_VIEWS = ['mine', 'all'] as const;
export type TaskView = (typeof TASK_VIEWS)[number];

export const MAX_TASK_TITLE = 200;
export const MAX_TASK_NOTE = 2000;
/** The default clock time of a new task's due moment (crm.md §11 screen 10). */
export const DEFAULT_TASK_TIME = '10:00';

// No control characters in a title; a note may hold line breaks and tabs.
// eslint-disable-next-line no-control-regex
const NO_CONTROL = /^[^\u0000-\u001f\u007f]*$/;
// eslint-disable-next-line no-control-regex
const NOTE_TEXT = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/;

/** A calendar date, YYYY-MM-DD, a real one, in 2000 to 2100. */
export const TaskDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-10.')
  .refine((value) => {
    const [y, m, d] = value.split('-').map(Number) as [number, number, number];
    const at = new Date(Date.UTC(y, m - 1, d));
    return (
      y >= 2000 &&
      y <= 2100 &&
      at.getUTCFullYear() === y &&
      at.getUTCMonth() === m - 1 &&
      at.getUTCDate() === d
    );
  }, 'Pick a real date.');

/** A clock time, HH:MM on the 24-hour clock. */
export const TaskTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 10:00.');

const TaskTitleSchema = z
  .string()
  .trim()
  .min(1, 'Say what needs doing.')
  .max(MAX_TASK_TITLE, `Keep it to ${MAX_TASK_TITLE} characters.`)
  .regex(NO_CONTROL, 'Use plain text.');
const TaskNoteSchema = z
  .string()
  .max(MAX_TASK_NOTE, `Keep the note to ${MAX_TASK_NOTE} characters.`)
  .regex(NOTE_TEXT, 'Use plain text.');

/** GET /api/admin/crm/tasks: whose, and optionally one contact's or one lead's. */
export const TaskQuerySchema = z
  .object({
    view: z.enum(TASK_VIEWS).optional(),
    contact: z.string().uuid().optional(),
    lead: z.string().uuid().optional(),
  })
  .strict();
export type TaskQuery = z.infer<typeof TaskQuerySchema>;

/** POST /api/admin/crm/tasks: a new task. An empty note is sent as null or left out. */
export const TaskCreateSchema = z
  .object({
    title: TaskTitleSchema,
    type: z.enum(TASK_TYPES).optional(),
    dueDate: TaskDateSchema,
    dueTime: TaskTimeSchema,
    contactId: z.string().uuid().nullable().optional(),
    leadId: z.string().uuid().nullable().optional(),
    ownerId: z.string().uuid().nullable().optional(),
    note: TaskNoteSchema.nullable().optional(),
  })
  .strict();
export type TaskCreate = z.infer<typeof TaskCreateSchema>;

/** The fields of a task an edit changes (each moves its version), as the API names them. */
export const VERSIONED_TASK_FIELDS = [
  'title',
  'type',
  'dueDate',
  'dueTime',
  'contactId',
  'leadId',
  'ownerId',
  'note',
  'snooze',
] as const;

/**
 * PATCH /api/admin/crm/tasks/[id]: an edit (at the version read), a tick (`done`, unversioned:
 * it moves no version), or the snooze to tomorrow 10:00 in the studio's zone (versioned).
 */
export const TaskPatchSchema = z
  .object({
    version: z.number().int().min(1).optional(),
    title: TaskTitleSchema.optional(),
    type: z.enum(TASK_TYPES).optional(),
    dueDate: TaskDateSchema.optional(),
    dueTime: TaskTimeSchema.optional(),
    contactId: z.string().uuid().nullable().optional(),
    leadId: z.string().uuid().nullable().optional(),
    ownerId: z.string().uuid().nullable().optional(),
    note: TaskNoteSchema.nullable().optional(),
    done: z.boolean().optional(),
    snooze: z.literal('tomorrow_10').optional(),
  })
  .strict()
  .refine(
    (patch) =>
      Object.entries(patch).some(([field, value]) => field !== 'version' && value !== undefined),
    { message: 'nothing to change' },
  )
  .refine((patch) => (patch.dueDate === undefined) === (patch.dueTime === undefined), {
    message: 'a due date and a time go together',
    path: ['dueTime'],
  })
  .refine((patch) => patch.snooze === undefined || patch.dueDate === undefined, {
    message: 'snooze or a new due date, not both',
    path: ['snooze'],
  })
  .refine(
    (patch) =>
      patch.version !== undefined ||
      VERSIONED_TASK_FIELDS.every((field) => patch[field] === undefined),
    { message: 'send the version you read with a change', path: ['version'] },
  );
export type TaskPatch = z.infer<typeof TaskPatchSchema>;

/** DELETE /api/admin/crm/tasks/[id]: at the version read. */
export const TaskDeleteSchema = z.object({ version: z.number().int().min(1) }).strict();
