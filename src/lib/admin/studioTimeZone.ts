import type { SupabaseClient } from '@supabase/supabase-js';
import { DEFAULT_TIME_ZONE, isStudioTimeZone, type StudioTimeZone } from '@schemas/timeZones';
import { writeSystemLog } from '@/lib/data/systemLog';
import type { AuthContext } from '@/lib/auth/types';
import { clockFor, type Clock } from './relTime';

// The studio's time zone for one admin request (Admin v2 U9): `site_settings.timezone`, the one
// source (0075), read through the caller's own session client (every staff role reads
// site_settings: 0001's site_settings_staff_read), at most once per request: the first caller
// stores the PROMISE on `locals`, as the identity loader does, so a page's components and its
// layout share one read.
//
// Never throws. No session, no row (a tenant that never saved its settings), an error, or a
// value outside the closed list: the default, Riyadh, and an unreadable setting is logged once
// per isolate, so a screen printing the wrong zone is diagnosable rather than silent.

type ZoneLocals = Pick<App.Locals, 'studioTimeZone' | 'supabase' | 'session'>;

let warned = false;

async function warnOnce(message: string): Promise<void> {
  if (warned) return;
  warned = true;
  await writeSystemLog({ level: 'warn', source: 'admin:timezone', message });
}

/** Reads the tenant's zone through `sb`. Exported for the route kernel and the tests. */
export async function readStudioTimeZone(
  sb: SupabaseClient | undefined,
  auth: Pick<AuthContext, 'tenantId'> | null,
): Promise<StudioTimeZone> {
  if (!sb || !auth) return DEFAULT_TIME_ZONE;
  try {
    const { data, error } = await sb
      .from('site_settings')
      .select('timezone')
      .eq('tenant_id', auth.tenantId)
      .maybeSingle<{ timezone: unknown }>();
    if (error) {
      await warnOnce(`the studio's time zone could not be read; showing Riyadh time`);
      return DEFAULT_TIME_ZONE;
    }
    // No row yet: the tenant never saved its settings, and the column's default is Riyadh.
    if (!data) return DEFAULT_TIME_ZONE;
    if (isStudioTimeZone(data.timezone)) return data.timezone;
    await warnOnce(`the studio's time zone is not one of the listed zones; showing Riyadh time`);
    return DEFAULT_TIME_ZONE;
  } catch {
    await warnOnce(`the studio's time zone could not be read; showing Riyadh time`);
    return DEFAULT_TIME_ZONE;
  }
}

/** The studio's zone for this request, read once. */
export function studioTimeZone(locals: ZoneLocals): Promise<StudioTimeZone> {
  locals.studioTimeZone ??= readStudioTimeZone(locals.supabase, locals.session);
  return locals.studioTimeZone;
}

/** The admin's clock for this request: `clockFor(await studioTimeZone(locals))`. */
export async function studioClock(locals: ZoneLocals): Promise<Clock> {
  return clockFor(await studioTimeZone(locals));
}

/** Test seam: forget that an unreadable zone was logged. */
export function resetStudioTimeZoneWarning(): void {
  warned = false;
}
