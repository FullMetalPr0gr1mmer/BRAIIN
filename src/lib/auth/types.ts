// Canonical role + auth-context types. Role and tenant_id come from the JWT
// `app_metadata` (set by the Supabase Custom Access Token Hook) — NEVER from
// `user_metadata` (user-writable). See CLAUDE.md Pillar 1.

export const ROLES = ['admin', 'content_creator', 'seo', 'developer'] as const;
export type Role = (typeof ROLES)[number];

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
