import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '@/lib/auth/types';
import { readNotificationPrefs, type NotificationPrefs } from '@schemas/adminPrefs';
import { OptimisticLockError } from './errors';

// The signed-in person's own preferences row (`admin_user_prefs`, 0044), through the
// caller's RLS-bound client: the database lets a live member read and write their own row
// and nobody else's, and the queries name the tenant and the person as well, so a handler
// that forgot either would find nothing rather than a guess.
//
// A person has no row until they first save something; reading one that is not there is
// the defaults, at version 0.

const COLUMNS = 'notifications,notifications_seen_at,version';

export interface MyPrefs {
  /** 0 when there is no row yet: the version a first save must send. */
  version: number;
  notifications: NotificationPrefs;
  /** The bell's watermark: items older than this are read. */
  notificationsSeenAt: string | null;
}

interface PrefsRow {
  notifications: unknown;
  notifications_seen_at: string | null;
  version: number;
}

function toPrefs(row: PrefsRow | null): MyPrefs {
  return {
    version: row?.version ?? 0,
    notifications: readNotificationPrefs(row?.notifications),
    notificationsSeenAt: row?.notifications_seen_at ?? null,
  };
}

export async function readMyPrefs(sb: SupabaseClient, auth: AuthContext): Promise<MyPrefs> {
  const { data, error } = await sb
    .from('admin_user_prefs')
    .select(COLUMNS)
    .eq('tenant_id', auth.tenantId)
    .eq('user_id', auth.userId)
    .maybeSingle<PrefsRow>();
  if (error) throw new Error(`read preferences: ${error.message}`);
  return toPrefs(data);
}

const UNIQUE_VIOLATION = '23505';

// ── The dashboard's part (Admin v2 U1) ─────────────────────────────────────────────────

const DASHBOARD_COLUMNS = 'dashboard,quick_actions,version';

export interface MyDashboardPrefs {
  /** 0 when there is no row yet. */
  version: number;
  /** The stored layout, raw: src/lib/admin/dashboard/layout.ts reads it leniently. */
  dashboard: unknown;
  /** The stored quick actions, raw (readQuickActions reads them). */
  quickActions: unknown;
}

interface DashboardRow {
  dashboard: unknown;
  quick_actions: unknown;
  version: number;
}

const toDashboardPrefs = (row: DashboardRow | null): MyDashboardPrefs => ({
  version: row?.version ?? 0,
  dashboard: row?.dashboard ?? {},
  quickActions: row?.quick_actions ?? [],
});

/**
 * The dashboard's layout and quick actions: read by /admin alone (the shell's per-render read
 * stays the bell's three columns, readMyPrefs).
 */
export async function readMyDashboardPrefs(
  sb: SupabaseClient,
  auth: AuthContext,
): Promise<MyDashboardPrefs> {
  const { data, error } = await sb
    .from('admin_user_prefs')
    .select(DASHBOARD_COLUMNS)
    .eq('tenant_id', auth.tenantId)
    .eq('user_id', auth.userId)
    .maybeSingle<DashboardRow>();
  if (error) throw new Error(`read dashboard preferences: ${error.message}`);
  return toDashboardPrefs(data);
}

/** What a save may change: any of the three preferences (columns), already validated. */
export interface PrefsPatch {
  notifications?: NotificationPrefs | undefined;
  dashboard?: object | undefined;
  quickActions?: readonly unknown[] | undefined;
}

export type SavedPrefs = MyPrefs & Omit<MyDashboardPrefs, 'version'>;

interface FullRow extends PrefsRow, DashboardRow {}
const ALL_COLUMNS = 'notifications,notifications_seen_at,dashboard,quick_actions,version';

/**
 * Saves the preferences a patch names, under the optimistic lock: `version` is the row's as
 * the person last read it (0 for no row). A stale version is a 409, never a silent overwrite
 * of a save made in another tab; a column the patch leaves out is left as it is.
 */
export async function saveMyPrefs(
  sb: SupabaseClient,
  auth: AuthContext,
  version: number,
  patch: PrefsPatch,
): Promise<SavedPrefs> {
  const values: Record<string, unknown> = {};
  if (patch.notifications !== undefined) values['notifications'] = patch.notifications;
  if (patch.dashboard !== undefined) values['dashboard'] = patch.dashboard;
  if (patch.quickActions !== undefined) values['quick_actions'] = patch.quickActions;
  const toSaved = (row: FullRow | null): SavedPrefs => ({
    ...toPrefs(row),
    dashboard: row?.dashboard ?? {},
    quickActions: row?.quick_actions ?? [],
  });

  if (version === 0) {
    const { data, error } = await sb
      .from('admin_user_prefs')
      .insert({ tenant_id: auth.tenantId, user_id: auth.userId, ...values })
      .select(ALL_COLUMNS)
      .maybeSingle<FullRow>();
    // A row appeared since the person read "none": someone saved first, in another tab.
    if (error?.code === UNIQUE_VIOLATION) throw new OptimisticLockError('admin_user_prefs');
    if (error) throw new Error(`create preferences: ${error.message}`);
    return toSaved(data);
  }
  const { data, error } = await sb
    .from('admin_user_prefs')
    .update(values)
    .eq('tenant_id', auth.tenantId)
    .eq('user_id', auth.userId)
    .eq('version', version)
    .select(ALL_COLUMNS)
    .maybeSingle<FullRow>();
  if (error) throw new Error(`save preferences: ${error.message}`);
  if (!data) throw new OptimisticLockError('admin_user_prefs');
  return toSaved(data);
}

/** Saves the notification preferences alone (F8's call, kept for its callers). */
export async function saveMyNotificationPrefs(
  sb: SupabaseClient,
  auth: AuthContext,
  version: number,
  notifications: NotificationPrefs,
): Promise<MyPrefs> {
  const saved = await saveMyPrefs(sb, auth, version, { notifications });
  return {
    version: saved.version,
    notifications: saved.notifications,
    notificationsSeenAt: saved.notificationsSeenAt,
  };
}

/**
 * Where "Mark all as read" puts the watermark: the moment the person's list was read (the
 * feed's `asOf`, sent back by the drawer or the no-JS form), held to this Worker's now, so
 * a clock ahead cannot mark the future read. The database holds it to its own now again.
 */
export function seenUpTo(asOf: string, now: number = Date.now()): Date {
  return new Date(Math.min(Date.parse(asOf), now));
}

/**
 * "Mark all as read": moves the watermark to `at`, the moment the list the person was
 * shown was read (seenUpTo), never the time of the click: what arrived in between stays
 * unread. Not versioned (the database moves the version only when a preference changes, so
 * this never makes a save in between a 409), and the database keeps the watermark moving
 * forward only and never past its own clock.
 */
export async function markNotificationsSeen(
  sb: SupabaseClient,
  auth: AuthContext,
  at: Date,
): Promise<string> {
  const seen = at.toISOString();
  const update = () =>
    sb
      .from('admin_user_prefs')
      .update({ notifications_seen_at: seen })
      .eq('tenant_id', auth.tenantId)
      .eq('user_id', auth.userId)
      .select('notifications_seen_at')
      .maybeSingle<{ notifications_seen_at: string | null }>();

  const first = await update();
  if (first.error) throw new Error(`mark read: ${first.error.message}`);
  if (first.data) return first.data.notifications_seen_at ?? seen;

  // No row yet: the first thing this person saves is that they read the bell.
  const created = await sb
    .from('admin_user_prefs')
    .insert({ tenant_id: auth.tenantId, user_id: auth.userId, notifications_seen_at: seen })
    .select('notifications_seen_at')
    .maybeSingle<{ notifications_seen_at: string | null }>();
  if (created.error?.code === UNIQUE_VIOLATION) {
    // Created in another tab a moment ago: the update now finds it.
    const again = await update();
    if (again.error || !again.data) throw new Error('mark read: the row could not be updated');
    return again.data.notifications_seen_at ?? seen;
  }
  if (created.error) throw new Error(`mark read: ${created.error.message}`);
  return created.data?.notifications_seen_at ?? seen;
}
