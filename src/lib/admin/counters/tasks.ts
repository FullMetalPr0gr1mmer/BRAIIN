import type { Counter } from './types';

// My overdue tasks, beside Tasks (Admin v2 C8, owner item O-9: the caller's own, not
// everyone's as in the prototype): open tasks the caller owns that were due before now.
// public.crm_my_overdue_tasks (0134) is a SECURITY INVOKER count through the caller's client,
// so RLS and the live check decide, and no row leaves the database. An error counts as no
// count (the shell shows none), never as zero.
export const tasks: Counter = (sb, tenantId) =>
  sb
    .rpc('crm_my_overdue_tasks', { p_tenant: tenantId })
    .then(({ data, error }) => ({ count: error || typeof data !== 'number' ? null : data }));
