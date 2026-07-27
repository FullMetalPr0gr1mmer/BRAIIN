import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from './types';
import { isRole } from './types';
import { serviceClient } from '@/lib/supabase/server';

// Resolves the verified auth context for a request, or null (→ deny).
//
// Two independent facts have to agree before a request is treated as authenticated:
//
//   1. The JWT is genuine. `getUser()` — never `getSession()` — because getSession()
//      returns whatever is in the cookie WITHOUT verifying its signature. On a server
//      that is not a session check, it is an attacker-supplied JSON parse.
//
//   2. The profile row still says so. Roles live in the JWT (that is what RLS reads),
//      and a JWT stays valid until it expires, so a demotion or deactivation would
//      otherwise take effect only after the token rolled over. We re-read
//      profiles.role/is_active/locked_until on every admin request.
//
// ── Why divergence DENIES instead of downgrading ─────────────────────────────────
// The obvious move when the JWT says `admin` and the row says `seo` is "use the row" —
// and for assertCap() that is right. But it is not sufficient, because assertCap() is
// the SECONDARY layer: Postgres RLS, the primary one, reads app_metadata.role out of
// the JWT and would still be enforcing `admin` for every query this request makes.
// Downgrading only the layer that reads the database would leave the demoted user with
// full admin rights at the layer that matters most. So divergence invalidates the
// session outright; the next login mints a JWT that both layers agree on. This is
// also what makes "force-revoke sessions on role/tenant change" true in practice.

export interface ResolveResult {
  ctx: AuthContext | null;
  /** Set when a session existed but must be torn down (stale role/tenant, lockout). */
  revoke: boolean;
}

interface ProfileRow {
  tenant_id: unknown;
  role: unknown;
  is_active: unknown;
  locked_until: unknown;
}

const DENY_ANON: ResolveResult = { ctx: null, revoke: false };
const DENY_REVOKE: ResolveResult = { ctx: null, revoke: true };

export async function resolveAuthContext(supabase: SupabaseClient): Promise<ResolveResult> {
  let userId: string;
  let email: string;
  let jwtRole: unknown;
  let jwtTenant: unknown;

  try {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) return DENY_ANON;
    userId = data.user.id;
    email = data.user.email ?? '';
    // app_metadata ONLY. user_metadata is writable by the user themselves, so a role
    // read from it is a self-service privilege escalation.
    const meta = data.user.app_metadata as Record<string, unknown> | undefined;
    jwtRole = meta?.['role'];
    jwtTenant = meta?.['tenant_id'];
  } catch {
    return DENY_ANON;
  }

  // A session with no role/tenant claim never had access to begin with — the Custom
  // Access Token Hook did not stamp it, so RLS would resolve this user into the anon
  // fence. Treat as anonymous rather than half-authenticated.
  if (!isRole(jwtRole) || typeof jwtTenant !== 'string' || jwtTenant.length === 0) {
    return DENY_ANON;
  }

  let profile: ProfileRow | null = null;
  try {
    const { data, error } = await serviceClient()
      .from('profiles')
      .select('tenant_id,role,is_active,locked_until')
      .eq('id', userId)
      .maybeSingle<ProfileRow>();
    // A failed live-recheck is a DENY, not a pass. Falling back to the JWT here would
    // mean a database outage silently re-enables every account we just disabled.
    if (error || !data) return DENY_REVOKE;
    profile = data;
  } catch {
    return DENY_REVOKE;
  }

  const {
    tenant_id: dbTenant,
    role: dbRole,
    is_active: isActive,
    locked_until: lockedUntil,
  } = profile;

  if (isActive !== true) return DENY_REVOKE;
  if (typeof lockedUntil === 'string' && Date.parse(lockedUntil) > Date.now()) return DENY_REVOKE;
  if (!isRole(dbRole) || typeof dbTenant !== 'string') return DENY_REVOKE;

  // See the header comment: stale claims cannot be downgraded, only rejected.
  if (dbRole !== jwtRole || dbTenant !== jwtTenant) return DENY_REVOKE;

  return {
    ctx: { userId, tenantId: dbTenant, role: dbRole, isActive: true, email },
    revoke: false,
  };
}
