import type { AuthContext } from '@/lib/auth/types';
import { isRole } from '@/lib/auth/types';
import { serviceClient } from '@/lib/supabase/server';
import { AuthorizationError } from '@/lib/authz/errors';

// Re-reads `profiles.role / is_active / locked_until` at the moment a privileged
// operation runs (CLAUDE.md §3: export-backup / export-csv / user management).
//
// `resolveAuthContext` already does this once per admin request, so on the surface this
// is redundant. It is not, and the difference is the word "moment": that check happened
// when the request arrived, and an export can take seconds to assemble. This runs
// immediately before the data is read, so "demotion effective immediately" means
// immediately rather than "from the next request onwards".
//
// It also makes the requirement independently TESTABLE — CLAUDE.md §9 asks for a
// regression test that demotes a user without refreshing their token and asserts the
// export endpoint 403s. That test needs a seam it can point at; this is the seam.

interface ProfileRow {
  role: unknown;
  is_active: unknown;
  locked_until: unknown;
}

export async function liveRecheck(auth: AuthContext): Promise<void> {
  let profile: ProfileRow | null = null;
  try {
    const { data, error } = await serviceClient()
      .from('profiles')
      .select('role,is_active,locked_until')
      .eq('id', auth.userId)
      .eq('tenant_id', auth.tenantId)
      .maybeSingle<ProfileRow>();
    if (error) throw new Error(error.message);
    profile = data;
  } catch {
    // Fail closed: an unreadable profile table is not permission to dump the lead table.
    throw new AuthorizationError('live-recheck', 'profile unreadable');
  }

  if (!profile) throw new AuthorizationError('live-recheck', 'profile missing');
  if (profile.is_active !== true) throw new AuthorizationError('live-recheck', 'account disabled');
  if (typeof profile.locked_until === 'string' && Date.parse(profile.locked_until) > Date.now()) {
    throw new AuthorizationError('live-recheck', 'account locked');
  }
  if (!isRole(profile.role) || profile.role !== auth.role) {
    throw new AuthorizationError('live-recheck', 'role changed since the session was issued');
  }
}
