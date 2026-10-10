import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '@/lib/auth/types';
import { getMaintenanceState, type MaintenanceState } from '@/lib/http/maintenance';
import { COUNTERS } from './counters';
import { adminEnvironment, type AdminEnvironment } from './environment';
import type { NavCount, NavGroup } from './nav';
import { loadNotifications } from './notifications';

export { initialsOf } from './initials';

// What the admin shell shows besides the menu (Admin v2 F2, F8): the head counts beside
// sidebar links, the "Maintenance on" badge, the signed-in person's name, the environment
// pill and the bell's unread count.
//
// Read on every admin render (Tier C, no-store), so every read is cheap and parallel:
// HEAD counts only for the menu (no rows leave the database), one KV read shared by the
// badge and the bell, one profile row, the environment from a per-isolate cache, and the
// bell's few small reads (src/lib/admin/notifications). A count is computed only for a
// link the role can see, and a bell source only for a role it is visible to — a Content
// Creator must not learn the lead volume from a badge when the whole leads area is closed
// to them — and every read goes through the RLS-bound client, so the database applies the
// same rule a second time. A failed read leaves its item out: the shell is decoration
// around the page, and a count or a badge is never worth an error screen. Each count is
// one module in ./counters, registered by the key a link's `count` names.

export interface ShellState {
  displayName: string | null;
  maintenance: boolean;
  counts: Partial<Record<NavCount, number>>;
  /** The environment pill, or null to show none (unmarked database or a failed read). */
  environment: AdminEnvironment | null;
  /** The bell's unread items (at most the 30 it lists). */
  unread: number;
}

async function settle<T>(work: () => PromiseLike<T>): Promise<T | null> {
  try {
    return await work();
  } catch {
    return null;
  }
}

export async function loadShellState(
  sb: SupabaseClient,
  auth: AuthContext,
  nav: readonly NavGroup[],
  env: { SESSION?: KVNamespace },
): Promise<ShellState> {
  const wanted = [
    ...new Set(
      nav.flatMap((group) => group.links.flatMap((link) => (link.count ? [link.count] : []))),
    ),
  ];

  // One KV read, for the badge and the bell's maintenance item alike.
  const maintenanceRead: Promise<MaintenanceState | null> = settle(() => getMaintenanceState(env));

  const [profile, maintenance, environment, feed, ...counts] = await Promise.all([
    settle(() =>
      sb
        .from('profiles')
        .select('display_name')
        .eq('id', auth.userId)
        .maybeSingle<{ display_name: string | null }>(),
    ),
    maintenanceRead,
    settle(() => adminEnvironment(sb, auth.tenantId)),
    settle(() => loadNotifications(sb, auth, { maintenance: () => maintenanceRead })),
    ...wanted.map((key) => settle(() => COUNTERS[key](sb, auth.tenantId))),
  ]);

  const state: ShellState = {
    displayName: profile?.data?.display_name?.trim() || null,
    maintenance: maintenance?.active === true,
    counts: {},
    environment: environment ?? null,
    unread: feed?.unread ?? 0,
  };
  wanted.forEach((key, index) => {
    const count = counts[index]?.count;
    if (typeof count === 'number') state.counts[key] = count;
  });
  return state;
}
