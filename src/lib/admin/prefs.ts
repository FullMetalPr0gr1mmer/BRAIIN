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

/**
 * Saves the notification preferences under the optimistic lock: `version` is the row's as
 * the person last read it (0 for no row). A stale version is a 409, never a silent
 * overwrite of a save made in another tab.
 */
export async function saveMyNotificationPrefs(
  sb: SupabaseClient,
  auth: AuthContext,
  version: number,
  notifications: NotificationPrefs,
): Promise<MyPrefs> {
  if (version === 0) {
    const { data, error } = await sb
      .from('admin_user_prefs')
      .insert({ tenant_id: auth.tenantId, user_id: auth.userId, notifications })
      .select(COLUMNS)
      .maybeSingle<PrefsRow>();
    // A row appeared since the person read "none": someone saved first, in another tab.
    if (error?.code === UNIQUE_VIOLATION) throw new OptimisticLockError('admin_user_prefs');
    if (error) throw new Error(`create preferences: ${error.message}`);
    return toPrefs(data);
  }
  const { data, error } = await sb
    .from('admin_user_prefs')
    .update({ notifications })
    .eq('tenant_id', auth.tenantId)
    .eq('user_id', auth.userId)
    .eq('version', version)
    .select(COLUMNS)
    .maybeSingle<PrefsRow>();
  if (error) throw new Error(`save preferences: ${error.message}`);
  if (!data) throw new OptimisticLockError('admin_user_prefs');
  return toPrefs(data);
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
