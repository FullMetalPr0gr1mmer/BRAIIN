// Canonical role + auth-context types. Role and tenant_id come from the JWT
// `app_metadata` (set by the Supabase Custom Access Token Hook) — NEVER from
// `user_metadata` (user-writable). See CLAUDE.md Pillar 1.

export const ROLES = ['admin', 'content_creator', 'seo', 'developer', 'sales'] as const;
export type Role = (typeof ROLES)[number];

/**
 * The CMS staff roles: the four `app.is_staff()` names (README P-6). Sales (Admin v2 C10a)
 * is a member but not CMS staff: it works leads and reads no draft, setting or staff-only
 * content, in the database and here alike.
 */
export const CMS_ROLES = [
  'admin',
  'content_creator',
  'seo',
  'developer',
] as const satisfies readonly Role[];

export function isCmsRole(role: Role): boolean {
  return (CMS_ROLES as readonly Role[]).includes(role);
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export interface AuthContext {
  readonly userId: string;
  readonly tenantId: string;
  readonly role: Role;
  /** Mirrors profiles.is_active; a demoted/disabled user fails assertCap immediately. */
  readonly isActive: boolean;
  readonly email: string;
}
