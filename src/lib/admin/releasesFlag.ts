import type { SupabaseClient } from '@supabase/supabase-js';
import { CMS_ROLES, type AuthContext } from '@/lib/auth/types';
import { RESOURCES } from '@/lib/admin/resources';
import { stagedEntry } from '@/lib/release/staged';

// Whether releases are on for the signed-in person's tenant, for one admin render (Admin v2
// R12, R12b): `public.releases_enabled` (0062: false for any tenant but the caller's), read for
// a CMS role only, never for Sales (who reads nothing a release holds). Read at most once per
// request: the first caller stores the PROMISE on `locals`, as studioTimeZone does, so a page
// that asks (a create page, R12b) and the shell (the savebar, R12) share one read. The shell
// read it on every CMS render already, so asking here adds no request, with releases on or off.
//
// Never throws. Anything but the database's `true` (off, an error, a throw, an odd value) is
// false: with releases off, and on a failed read, every page is what it was.

type FlagLocals = Pick<App.Locals, 'releasesEnabled' | 'supabase' | 'session'>;

/** Reads the flag through `sb` (the shell's own read when no page asked first). */
export async function readReleasesEnabled(
  sb: SupabaseClient | undefined,
  auth: Pick<AuthContext, 'role' | 'tenantId'> | null,
): Promise<boolean> {
  if (!sb || !auth || !(CMS_ROLES as readonly string[]).includes(auth.role)) return false;
  try {
    const { data, error } = await sb.rpc('releases_enabled', { p_tenant: auth.tenantId });
    return error == null && data === true;
  } catch {
    return false;
  }
}

/** The flag for this request, read once. */
export function releasesEnabled(locals: FlagLocals): Promise<boolean> {
  locals.releasesEnabled ??= readReleasesEnabled(locals.supabase, locals.session);
  return locals.releasesEnabled;
}

/**
 * A create page's mode (R12b): true when releases are on and `slug` is a release-managed
 * resource, so the page's create carries the marker (`?staged=1`, SaveTarget `staged`) and,
 * if releases are switched off while the page is open, is refused (409 `releases-off`)
 * instead of written live. A resource outside the release (the Style-Finder's) is false
 * without asking: its create is main's request with releases on or off.
 */
export async function createReleaseMode(locals: FlagLocals, slug: string): Promise<boolean> {
  const config = RESOURCES[slug];
  if (!config || stagedEntry(config) === undefined) return false;
  return releasesEnabled(locals);
}
