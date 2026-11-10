import { TaskCreateSchema, TaskQuerySchema } from '@schemas/crmTasks';
import { defineAdminRoute } from '@/lib/admin/route';
import { ValidationError } from '@/lib/admin/errors';
import { createBody, parseGroups, pickTask, taskError } from '@/lib/crm/tasks';

// Tasks (Admin v2 C8, crm.md §9): the list, grouped (GET), and a new task (POST). `crm.tasks`
// (Admin only until C10b). Both run as the caller through SECURITY INVOKER functions (0134):
// RLS and the live check decide what is read and written, the Worker names the tenant and the
// database refuses any other. Every moment is worked out in SQL in the studio's zone
// (site_settings.timezone): the lists are grouped there (overdue, today, upcoming, done) and a
// new task's local date and time become its instant there, never in a browser.
//
// The list carries each task's title, note and the names of the contact and the lead it is
// about: never a contact detail. A read is not audited (it reveals nothing gated, as the leads
// list); a new task is (`crm.task.create`, ids and the type only, never the words).

export const prerender = false;

export const GET = defineAdminRoute({
  cap: 'crm.tasks',
  input: TaskQuerySchema,
  handler: async ({ auth, sb, input }) => {
    const filter: Record<string, string> = { view: input.view ?? 'all' };
    if (input.contact) filter['contact'] = input.contact;
    if (input.lead) filter['lead'] = input.lead;
    const { data, error } = await sb.rpc('crm_tasks_grouped', {
      p_tenant: auth.tenantId,
      p_filter: filter,
    });
    if (error) throw taskError(error, 'the tasks');
    return parseGroups(data);
  },
});

export const POST = defineAdminRoute({
  cap: 'crm.tasks',
  input: TaskCreateSchema,
  handler: async ({ auth, sb, input, audit }) => {
    const { data, error } = await sb.rpc('crm_task_create', {
      p_tenant: auth.tenantId,
      p_task: createBody(input),
    });
    if (error) throw taskError(error, 'the new task');
    const task = pickTask(data);
    if (!task) throw new ValidationError('the new task was refused');
    audit({
      action: 'crm.task.create',
      entityType: 'task',
      entityId: task.id,
      detail: {
        type: task.type,
        ...(task.contact_id ? { contact: task.contact_id } : {}),
        ...(task.lead_id ? { lead: task.lead_id } : {}),
        mine: task.owner_id === auth.userId,
      },
    });
    return task;
  },
});
