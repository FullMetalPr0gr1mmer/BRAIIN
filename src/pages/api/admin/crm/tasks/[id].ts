import { TaskDeleteSchema, TaskPatchSchema } from '@schemas/crmTasks';
import { defineAdminRoute } from '@/lib/admin/route';
import { NotFoundError } from '@/lib/admin/errors';
import { changedFields, patchBody, pickTask, requireTaskId, taskError } from '@/lib/crm/tasks';

// One task (Admin v2 C8, crm.md §9): a change (PATCH) and its removal (DELETE). `crm.tasks`.
// Immediate (P-3: CRM data is never staged into a release). Both run as the caller through
// SECURITY INVOKER functions (0134), so RLS and the live check decide.
//
// PATCH: an edit carries the version the screen read (a 409 when it moved: "Someone else
// changed this. Refreshed."); a tick (`done`) is unversioned and moves no version, so two
// people ticking one task never collide; `snooze: 'tomorrow_10'` is worked out in SQL in the
// studio's zone. DELETE carries the version read too. Both are audited (`crm.task.update`
// with the field names, `crm.task.delete`), never with what a field holds.

export const prerender = false;

export const PATCH = defineAdminRoute({
  cap: 'crm.tasks',
  input: TaskPatchSchema,
  handler: async ({ auth, sb, input, params, audit }) => {
    const id = requireTaskId(params);
    const { data, error } = await sb.rpc('crm_task_update', {
      p_tenant: auth.tenantId,
      p_task: id,
      p_version: input.version ?? null,
      p_patch: patchBody(input),
    });
    if (error) throw taskError(error, 'the task');
    const task = pickTask(data);
    if (!task) throw new NotFoundError('task');
    audit({
      action: 'crm.task.update',
      entityType: 'task',
      entityId: id,
      detail: {
        fields: changedFields(input),
        ...(input.done !== undefined ? { done: input.done } : {}),
      },
    });
    return task;
  },
});

export const DELETE = defineAdminRoute({
  cap: 'crm.tasks',
  input: TaskDeleteSchema,
  handler: async ({ auth, sb, input, params, audit }) => {
    const id = requireTaskId(params);
    const { data, error } = await sb.rpc('crm_task_delete', {
      p_tenant: auth.tenantId,
      p_task: id,
      p_version: input.version,
    });
    if (error) throw taskError(error, 'the task');
    const was = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
    audit({
      action: 'crm.task.delete',
      entityType: 'task',
      entityId: id,
      detail: {
        ...(typeof was['contact_id'] === 'string' ? { contact: was['contact_id'] } : {}),
        ...(typeof was['lead_id'] === 'string' ? { lead: was['lead_id'] } : {}),
        done: was['done'] === true,
      },
    });
    return { id };
  },
});
