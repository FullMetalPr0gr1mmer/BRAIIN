import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { ROLES, type Role } from '@/lib/auth/types';
import { TENANT_ID } from '../../scripts/gen-seeds.mjs';

/*
 * Staff accounts for the admin e2e harness (Admin v2 F0), one per role.
 *
 * LOCAL STACKS ONLY. The accounts are created through the GoTrue admin API with the
 * service role, with a password that is random per run and lives only in this process's
 * memory: the setup signs each role in once and keeps the SESSION (playwright/.auth,
 * gitignored), never the password. Nothing here is in supabase/seed.sql, which also runs
 * on staging, so no known credential can reach a real environment.
 *
 * The guard is the address, not `app.deployment`: the marker and app.is_production() are
 * deliberately unreachable by every API role (migration 0016), so a test runner cannot
 * ask the database what it is. A loopback Supabase URL is a stricter test anyway: it
 * rules out staging as well as production. The preview the browser signs in to must be
 * loopback too, or the sign-ins would land as failed attempts on a real project.
 */

export const STAFF_ROLES: readonly Role[] = ROLES;

/** Fixed ids keep the setup idempotent on a local stack that outlives one run. */
const STAFF_IDS: Record<Role, string> = {
  admin: 'e2e00000-0000-4000-8000-000000000001',
  content_creator: 'e2e00000-0000-4000-8000-000000000002',
  seo: 'e2e00000-0000-4000-8000-000000000003',
  developer: 'e2e00000-0000-4000-8000-000000000004',
};

export function staffEmail(role: Role): string {
  return `e2e-${role.replace('_', '-')}@example.com`;
}

/** Saved sessions, gitignored. Absolute, so no spec depends on the working directory. */
const AUTH_DIR = fileURLToPath(new URL('../../playwright/.auth/', import.meta.url));

/** The saved session of one role, written by staff.setup.ts. */
export function authFile(role: Role): string {
  return `${AUTH_DIR}${role}.json`;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/** True only for an http(s) URL whose host is this machine. */
export function isLoopbackUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return LOOPBACK_HOSTS.has(url.hostname.replace(/^\[|\]$/g, ''));
}

export interface StaffEnv {
  url: string;
  serviceKey: string;
}

/**
 * The local Supabase the harness may write to, or null, in which case every admin spec
 * skips. Null unless the Supabase URL AND the preview are loopback and the service key
 * is present (the perf-seo-a11y e2e job exports all three).
 */
export function staffEnv(env: Record<string, string | undefined> = process.env): StaffEnv | null {
  const url = (env['PUBLIC_SUPABASE_URL'] ?? '').replace(/\/$/, '');
  const serviceKey = env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';
  const preview = env['PREVIEW_URL'] ?? 'http://localhost:8788';
  if (!serviceKey || !isLoopbackUrl(url) || !isLoopbackUrl(preview)) return null;
  return { url, serviceKey };
}

export const SKIP_REASON =
  'needs the e2e job: a LOCAL seeded Supabase, its service key, and a loopback preview';

/**
 * Creates (or resets) the role's account and profile, and returns credentials valid for
 * this run only. The profile row is what the access-token hook stamps into the JWT, and
 * app_metadata mirrors it, as `POST /api/admin/users` does: resolveAuthContext refuses a
 * session whose claims and profile disagree.
 */
export async function ensureStaff(
  env: StaffEnv,
  role: Role,
): Promise<{ email: string; password: string }> {
  const svc = createClient(env.url, env.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const id = STAFF_IDS[role];
  const email = staffEmail(role);
  const password = randomBytes(24).toString('base64url');
  const attributes = {
    email,
    password,
    email_confirm: true,
    app_metadata: { role, tenant_id: TENANT_ID },
  };

  const existing = await svc.auth.admin.getUserById(id);
  const { error: userError } = existing.data.user
    ? await svc.auth.admin.updateUserById(id, attributes)
    : await svc.auth.admin.createUser({ id, ...attributes });
  if (userError) throw new Error(`staff ${role}: ${userError.message}`);

  const { error: profileError } = await svc.from('profiles').upsert({
    id,
    tenant_id: TENANT_ID,
    role,
    is_active: true,
    locked_until: null,
    display_name: `E2E ${role.replace('_', ' ')}`,
  });
  if (profileError) throw new Error(`staff ${role} profile: ${profileError.message}`);

  // A local re-run after failed sign-ins would otherwise meet the lockout (5 failures in
  // 15 minutes answer 423). Best-effort: a fresh CI database has no attempts at all.
  await svc.from('login_attempts').delete().eq('email', email);

  return { email, password };
}
