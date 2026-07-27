import { serviceClient } from '@/lib/supabase/server';

// Login lockout (CLAUDE.md §3): 5 failures / 15 min → 423 for 15 min, generic copy.
//
// The counting and the `profiles.locked_until` stamp both happen inside one
// security-definer RPC (migration 0009) so they cannot race under a credential-stuffing
// run. This module is the thin Worker-side wrapper.
//
// FAIL CLOSED: if the lockout store is unreachable we report "locked". An outage in the
// component whose whole job is to throttle password guessing must not be the thing that
// removes the throttle.

export const LOCKOUT_THRESHOLD = 5;
export const LOCKOUT_WINDOW_MINUTES = 15;
export const LOCKOUT_DURATION_MINUTES = 15;

/** True when this email is currently locked out and login must answer 423. */
export async function isLockedOut(email: string): Promise<boolean> {
  try {
    const { data, error } = await serviceClient().rpc('login_is_locked', { p_email: email });
    if (error) return true;
    return data === true;
  } catch {
    return true;
  }
}

/** Records a failed attempt. Returns true when this attempt tripped the lockout. */
export async function registerFailure(email: string, ip: string | null): Promise<boolean> {
  try {
    const { data, error } = await serviceClient().rpc('register_failed_login', {
      p_email: email,
      p_ip: ip,
    });
    if (error) return false;
    return data === true;
  } catch {
    return false;
  }
}

/** Clears the failure counter and stamps last_login_at. Best-effort. */
export async function registerSuccess(email: string, ip: string | null): Promise<void> {
  try {
    await serviceClient().rpc('register_successful_login', { p_email: email, p_ip: ip });
  } catch {
    // A bookkeeping failure must not block a legitimate login.
  }
}
