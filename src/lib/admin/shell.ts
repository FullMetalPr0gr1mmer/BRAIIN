import type { SupabaseClient } from '@supabase/supabase-js';
import { CMS_ROLES, type AuthContext } from '@/lib/auth/types';
import { getMaintenanceState, type MaintenanceState } from '@/lib/http/maintenance';
import { COUNTERS } from './counters';
import { adminEnvironment, type AdminEnvironment } from './environment';
import type { NavCount, NavGroup } from './nav';
import { loadNotifications, type NotificationFeed } from './notifications';

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
//
// Admin v2 R12: whether releases are on for the tenant (`public.releases_enabled`, 0062: false
// for any tenant but the caller's), read for a CMS role only, never for Sales (who reads
// nothing a release holds), in the same parallel batch: one more subrequest on a CMS
// render. True draws the savebar (AdminLayout); false, a failed read included, draws nothing,
// so with releases off every admin page is what it was. An editor never reads this: it
// follows the server's answer on its own route (entitySave.ts).

export interface ShellState {
  displayName: string | null;
  maintenance: boolean;
  counts: Partial<Record<NavCount, number>>;
  /** The environment pill, or null to show none (unmarked database or a failed read). */
  environment: AdminEnvironment | null;
  /** The bell's unread items (at most the 30 it lists). */
  unread: number;
  /** Admin v2 R12: releases are on for the tenant: the savebar is drawn (CMS roles only). */
  releases: boolean;
}

async function settle<T>(work: () => PromiseLike<T>): Promise<T | null> {
  try {
    return await work();
  } catch {
    return null;
  }
}

/**
 * What a page already read for itself, so the shell does not read it a second time:
 * /admin/notifications loads the bell's whole feed (with labels) and the maintenance
 * snapshot it was built from, and the shell's unread count and badge come from those. The
 * dashboard (U1) reads the snapshot for its banner and the person's name for its greeting,
 * and leaves the feed to the shell.
 */
export interface ShellPreload {
  feed?: NotificationFeed | undefined;
  maintenance: MaintenanceState | null;
  /** The signed-in person's display name as the page read it (null: none set). */
  displayName?: string | null | undefined;
}

export async function loadShellState(
  sb: SupabaseClient,
  auth: AuthContext,
  nav: readonly NavGroup[],
  env: { SESSION?: KVNamespace },
  preload?: ShellPreload,
  /** The studio's time zone (Admin v2 U9): which day the bell's "goes live today" is. */
  tz?: string,
): Promise<ShellState> {
  const wanted = [
    ...new Set(
      nav.flatMap((group) => group.links.flatMap((link) => (link.count ? [link.count] : []))),
    ),
  ];

  // One KV read, for the badge and the bell's maintenance item alike (none at all when the
  // page read it already).
  const maintenanceRead: Promise<MaintenanceState | null> = preload
    ? Promise.resolve(preload.maintenance)
    : settle(() => getMaintenanceState(env));

  const preloadedName = preload && preload.displayName !== undefined;
  const readsReleases = (CMS_ROLES as readonly string[]).includes(auth.role);
  const [profile, maintenance, environment, feed, releases, ...counts] = await Promise.all([
    preloadedName
      ? Promise.resolve({ data: { display_name: preload?.displayName ?? null } })
      : settle(() =>
          sb
            .from('profiles')
            .select('display_name')
            .eq('id', auth.userId)
            .maybeSingle<{ display_name: string | null }>(),
        ),
    maintenanceRead,
    settle(() => adminEnvironment(sb, auth.tenantId)),
    preload?.feed
      ? Promise.resolve(preload.feed)
      : settle(() =>
          loadNotifications(sb, auth, {
            maintenance: () => maintenanceRead,
            ...(tz ? { tz } : {}),
          }),
        ),
    readsReleases
      ? settle(() => sb.rpc('releases_enabled', { p_tenant: auth.tenantId }))
      : Promise.resolve(null),
    ...wanted.map((key) => settle(() => COUNTERS[key](sb, auth.tenantId))),
  ]);

  const state: ShellState = {
    displayName: profile?.data?.display_name?.trim() || null,
    maintenance: maintenance?.active === true,
    counts: {},
    environment: environment ?? null,
    unread: feed?.unread ?? 0,
    releases: releases?.error == null && releases?.data === true,
  };
  wanted.forEach((key, index) => {
    const count = counts[index]?.count;
    if (typeof count === 'number') state.counts[key] = count;
  });
  return state;
}
