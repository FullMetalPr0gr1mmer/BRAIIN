import type { SupabaseClient } from '@supabase/supabase-js';
import { CTA_IDS } from '@schemas/analytics';
import {
  GOAL_METRICS,
  GoalCreateSchema,
  GoalUpdateSchema,
  MAX_GOALS,
  type GoalMetric,
} from '@schemas/analyticsGoals';
import type { AuthContext } from '@/lib/auth/types';
import type { ResourceConfig, ResourcePayload } from '../resource';
import { count, list, readError, record } from './read';

// Website stats goals (Admin v2 G1c): a number to reach this calendar month. Two halves:
//   - the resource the kernel serves at /api/admin/analytics/goals (list, read, create,
//     update with the version, delete), so the tenant predicate, assertCap, the optimistic
//     lock and the audit row are structural (src/lib/admin/resource.ts). `analytics.goals`
//     (Admin, SEO; CLAUDE.md §5) writes AND deletes, every `analytics.read` role reads.
//     Immediate (P-3: admin configuration, nothing public), so it is not in the release
//     registry, and it is not in RESOURCES: there is no list screen, no header search and no
//     editor page; the goals card on the Conversions tab is its one screen.
//   - progress, from public.goal_progress (migration 0071): each goal with what the rollups
//     counted since the first of this month (UTC days); inquiries only for a role that works
//     leads, null for the others, so a Content Creator never learns the volume of leads.

const SOURCE = 'admin:stats';

/** What toRow writes: the four fields, `cta` null unless the goal counts a click. */
function goalRow(input: ResourcePayload): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  if (typeof input['name'] === 'string') values['name'] = input['name'];
  if (typeof input['metric'] === 'string') {
    values['metric'] = input['metric'];
    values['cta'] = input['metric'] === 'cta' ? (input['cta'] ?? null) : null;
  }
  if (typeof input['target'] === 'number') values['target'] = input['target'];
  return values;
}

export const goalResource: ResourceConfig = {
  table: 'analytics_goals',
  entity: 'analytics_goal',
  writeCap: 'analytics.goals',
  // §5 gives the holders of analytics.goals the whole of goals, deletes included; the
  // content default (content.archiveDelete, Admin only) would refuse SEO.
  deleteCap: 'analytics.goals',
  readCaps: ['analytics.read'],
  readAccess: ['full'],
  listColumns: 'id,name,metric,cta,target,version,created_at',
  columns: 'id,name,metric,cta,target,version,created_at,updated_at',
  orderBy: { column: 'created_at', ascending: true },
  createSchema: GoalCreateSchema,
  updateSchema: GoalUpdateSchema,
  toRow: goalRow,
  constraintFields: {
    analytics_goals_limit: {
      field: 'name',
      message: `You can keep up to ${MAX_GOALS} goals. Delete one to add another.`,
    },
    analytics_goals_cta_pair: { field: 'cta', message: 'Only a click goal names a click.' },
  },
};

/** A goal as the goals card shows it. */
export interface GoalView {
  id: string;
  name: string;
  metric: GoalMetric;
  cta: string | null;
  target: number;
  version: number;
  /** Counted this month, or null when this role is not shown the figure (inquiries). */
  done: number | null;
}

export interface GoalProgress {
  /** The first day of this month, UTC (YYYY-MM-DD). */
  monthStart: string | null;
  goals: GoalView[];
}

const isMetric = (value: unknown): value is GoalMetric =>
  typeof value === 'string' && (GOAL_METRICS as readonly string[]).includes(value);

/** goal_progress's answer, read leniently: a goal with an unknown metric is left out. */
export function goalProgressOf(raw: unknown): GoalProgress {
  const data = record(raw);
  const month = data['month_start'];
  return {
    monthStart: typeof month === 'string' ? month : null,
    goals: list(data['goals']).flatMap((row) => {
      const id = row['id'];
      const metric = row['metric'];
      if (typeof id !== 'string' || !isMetric(metric)) return [];
      const cta = row['cta'];
      const done = row['done'];
      return [
        {
          id,
          name: String(row['name'] ?? ''),
          metric,
          cta: typeof cta === 'string' && (CTA_IDS as readonly string[]).includes(cta) ? cta : null,
          target: Math.max(1, count(row['target'])),
          version: Math.max(1, count(row['version'])),
          done: done === null || done === undefined ? null : count(done),
        },
      ];
    }),
  };
}

export async function loadGoalProgress(
  sb: SupabaseClient,
  auth: AuthContext,
): Promise<GoalProgress> {
  const { data, error } = await sb.rpc('goal_progress', { p_tenant: auth.tenantId });
  if (error) throw await readError(SOURCE, 'Goals', error);
  return goalProgressOf(data);
}
