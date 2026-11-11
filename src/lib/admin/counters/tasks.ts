import type { Counter } from './types';
import { crmCounts } from './crm';

// My overdue tasks, beside Tasks (Admin v2 C8, owner item O-9: the caller's own, not
// everyone's as in the prototype): open tasks the caller owns that were due before now.
// public.crm_nav_counts (0134) counts them as the caller (RLS and the live check decide), in
// the one read the Leads badge shares (./crm.ts), so no row leaves the database and the badge
// costs no subrequest of its own. A failed read shows no count, never zero.
export const tasks: Counter = (sb, tenantId) =>
  crmCounts(sb, tenantId).then((counts) => ({ count: counts.tasks }));
