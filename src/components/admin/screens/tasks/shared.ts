import type { TaskType } from '@schemas/crmTasks';
import type { IconName } from '@/lib/admin/icons';
import { AdminApiError, adminFetch, describeError } from '@/lib/admin/client';
import { confirmDialog } from '@/lib/admin/confirm';
import type { TaskGroups, TaskRow } from '@/lib/crm/tasks';

// What the Tasks screen, the Tasks card and the task drawer share (Admin v2 C8, crm.md §11
// screen 10): the words for each type, the writes every view of a task makes, and how a
// refusal is said. Every moment arrives worked out on the server in the studio's zone; the
// browser only prints it (the admin's clock, src/lib/admin/relTime.ts).

export type { TaskGroups, TaskRow };

/** Someone who may own a task (an active crm.tasks holder of the tenant). */
export interface TaskPerson {
  id: string;
  name: string;
}

/** A lead a task is about, as a lead's page knows it. */
export interface TaskLeadRef {
  id: string;
  number: number | null;
  name: string | null;
}

/** A contact a task is about. */
export interface TaskContactRef {
  id: string;
  name: string | null;
  company?: string | null | undefined;
}

export const TYPE_LABELS: Readonly<Record<TaskType, string>> = {
  call: 'Call',
  email: 'E-mail',
  whatsapp: 'WhatsApp',
  meeting: 'Meeting',
  todo: 'To do',
};

export const TYPE_ICONS: Readonly<Record<TaskType, IconName>> = {
  call: 'phone',
  email: 'mail',
  whatsapp: 'whatsapp',
  meeting: 'users',
  todo: 'check',
};

export const FORMER_MEMBER = 'Someone no longer on the team';
export const CONFLICT = 'Someone else changed this. Refreshed.';

/** A contact's page (Admin v2 C7). */
export const contactHref = (id: string) => `/admin/contacts/${id}`;
export const leadHref = (id: string) => `/admin/leads/${id}`;
export const icsHref = (id: string) => `/api/admin/crm/tasks/${id}/ics`;

/** The lead as a task names it: "Lead #12, Sara" (the name in its own direction is the caller's). */
export function leadLabel(task: Pick<TaskRow, 'lead_number'>): string {
  return task.lead_number === null ? 'Lead' : `Lead #${task.lead_number}`;
}

/** Is it a 409: someone else changed it since it was read? */
export const isConflict = (err: unknown) => err instanceof AdminApiError && err.info.status === 409;

/** What a failed write says: the conflict in the program's words, else the error's own. */
export const failureText = (err: unknown) => (isConflict(err) ? CONFLICT : describeError(err));

/** Ticks a task done, or opens it again. Unversioned: a tick never collides. */
export function setDone(task: TaskRow, done: boolean): Promise<TaskRow> {
  return adminFetch<TaskRow>(`/api/admin/crm/tasks/${task.id}`, {
    method: 'PATCH',
    body: { done },
  });
}

/** "Snooze to tomorrow 10:00", worked out on the server in the studio's zone. */
export function snooze(task: TaskRow): Promise<TaskRow> {
  return adminFetch<TaskRow>(`/api/admin/crm/tasks/${task.id}`, {
    method: 'PATCH',
    body: { version: task.version, snooze: 'tomorrow_10' },
  });
}

/** Removes a task after a confirm. False when the person kept it. */
export async function removeTask(task: TaskRow): Promise<boolean> {
  const sure = await confirmDialog({
    message: 'Delete this task? It cannot be brought back.',
    confirmLabel: 'Delete task',
  });
  if (!sure) return false;
  await adminFetch(`/api/admin/crm/tasks/${task.id}`, {
    method: 'DELETE',
    body: { version: task.version },
  });
  return true;
}

/** The open tasks of a group, overdue first, then today, then later. */
export const openTasks = (groups: TaskGroups): TaskRow[] => [
  ...groups.overdue,
  ...groups.dueToday,
  ...groups.upcoming,
];

/** Reads the grouped tasks for a filter. */
export function readTasks(
  query: { view?: 'mine' | 'all'; contact?: string; lead?: string },
  signal?: AbortSignal,
): Promise<TaskGroups> {
  const params = new URLSearchParams();
  if (query.view) params.set('view', query.view);
  if (query.contact) params.set('contact', query.contact);
  if (query.lead) params.set('lead', query.lead);
  return adminFetch<TaskGroups>(
    `/api/admin/crm/tasks?${params.toString()}`,
    signal ? { signal } : {},
  );
}
