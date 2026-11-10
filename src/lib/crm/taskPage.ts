import type { SupabaseClient } from '@supabase/supabase-js';
import type { TaskView } from '@schemas/crmTasks';
import { ROLES, type AuthContext, type Role } from '@/lib/auth/types';
import { can } from '@/lib/authz/matrix';
import { parseGroups, taskError, type TaskGroups } from './tasks';

// What the task screens read on the server (Admin v2 C8): the grouped tasks (the Tasks page's
// first view) and the people a task may be given to. Both read as the caller (RLS and the live
// check decide). Never a contact detail.

/** The grouped tasks for a filter, as GET /api/admin/crm/tasks answers them. Throws on a refusal. */
export async function readTaskGroups(
  sb: SupabaseClient,
  auth: AuthContext,
  filter: { view: TaskView; contact?: string; lead?: string },
): Promise<TaskGroups> {
  const { data, error } = await sb.rpc('crm_tasks_grouped', {
    p_tenant: auth.tenantId,
    p_filter: filter,
  });
  if (error) throw taskError(error, 'the tasks');
  return parseGroups(data);
}

/**
 * The people a task may be given to: the tenant's active lead workers (public.crm_people, the
 * directory the leads use) who also hold crm.tasks. A UX list: the database's owner rule
 * (app.tg_crm_task_row) is the check. Empty on any failure.
 */
export async function readTaskOwners(
  sb: SupabaseClient,
  auth: AuthContext,
): Promise<{ id: string; name: string }[]> {
  const { data, error } = await sb.rpc('crm_people', { p_tenant: auth.tenantId });
  if (error || !Array.isArray(data)) return [];
  return (data as Record<string, unknown>[]).flatMap((person) => {
    const id = person['id'];
    const role = person['role'];
    if (typeof id !== 'string' || typeof role !== 'string') return [];
    if (!(ROLES as readonly string[]).includes(role) || can(role as Role, 'crm.tasks') !== 'full') {
      return [];
    }
    const name = typeof person['display_name'] === 'string' ? person['display_name'].trim() : '';
    return [{ id, name: name || 'A member with no name' }];
  });
}
