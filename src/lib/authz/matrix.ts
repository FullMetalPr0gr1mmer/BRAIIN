// ─────────────────────────────────────────────────────────────────────────────
// ROLE × CAPABILITY MATRIX — SINGLE SOURCE OF TRUTH
// Byte-for-byte identical to CLAUDE.md §5 and architecture.md §3.4. A CI snapshot
// test (tests/authz/matrix.spec.ts) FAILS on any drift between this file and the
// documented matrices.
//
// Authorization is enforced in TWO independent server layers that must BOTH pass:
//   1) Postgres RLS  (PRIMARY)
//   2) assertCap()   (SECONDARY)
// The admin UI's `can()` gating is UX ONLY — never a security control.
// `anon` and `other_tenant` get DENY on every capability (handled before this map:
// no session → deny; tenant mismatch → deny in RLS and by tenant checks).
// ─────────────────────────────────────────────────────────────────────────────

import type { AuthContext, Role } from '@/lib/auth/types';
import { AuthorizationError } from '@/lib/authz/errors';

export type Access = 'full' | 'view' | 'meta' | 'none';

export const CAPABILITIES = [
  'users.manage',
  'settings.general',
  'settings.integrations',
  'maintenance.manage',
  'theme.edit',
  'services.write',
  'blog.write',
  'portfolio.write',
  'pages.write',
  'nav.edit',
  'categories.manage',
  'content.publish',
  'content.archiveDelete',
  'seo.entityMeta',
  'seo.globalDefaults',
  'redirects.manage',
  'media.write',
  'media.hardDelete',
  'leads.manage',
  'leads.pii',
  'export.csv',
  'analytics.read',
  'analytics.search',
  'ai.editContent',
  'ai.config',
  'logs.view',
  'logs.clear',
  'audit.view',
  'siteHealth.view',
  'export.backup',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const F: Access = 'full';
const N: Access = 'none';

export const ROLE_CAPS: Record<Role, Record<Capability, Access>> = {
  // Admin — everything.
  admin: {
    'users.manage': F,
    'settings.general': F,
    'settings.integrations': F,
    'maintenance.manage': F,
    'theme.edit': F,
    'services.write': F,
    'blog.write': F,
    'portfolio.write': F,
    'pages.write': F,
    'nav.edit': F,
    'categories.manage': F,
    'content.publish': F,
    'content.archiveDelete': F,
    'seo.entityMeta': F,
    'seo.globalDefaults': F,
    'redirects.manage': F,
    'media.write': F,
    'media.hardDelete': F,
    'leads.manage': F,
    'leads.pii': F,
    'export.csv': F,
    'analytics.read': F,
    'analytics.search': F,
    'ai.editContent': F,
    'ai.config': F,
    'logs.view': F,
    'logs.clear': F,
    'audit.view': F,
    'siteHealth.view': F,
    'export.backup': F,
  },
  // Content Creator — authors content AND publishes/schedules. No archive/delete,
  // no leads, no settings.
  content_creator: {
    'users.manage': N,
    'settings.general': N,
    'settings.integrations': N,
    'maintenance.manage': N,
    'theme.edit': N,
    'services.write': F,
    'blog.write': F,
    'portfolio.write': F,
    'pages.write': F,
    'nav.edit': F,
    'categories.manage': F,
    'content.publish': F,
    'content.archiveDelete': N,
    'seo.entityMeta': 'view',
    'seo.globalDefaults': N,
    'redirects.manage': N,
    'media.write': F,
    'media.hardDelete': N,
    'leads.manage': N,
    'leads.pii': N,
    'export.csv': N,
    'analytics.read': F,
    'analytics.search': N,
    'ai.editContent': F,
    'ai.config': N,
    'logs.view': N,
    'logs.clear': N,
    'audit.view': N,
    'siteHealth.view': N,
    'export.backup': N,
  },
  // SEO — per-entity + global SEO meta/schema, redirects/canonical, integrations +
  // analytics. No content body, no leads.
  seo: {
    'users.manage': N,
    'settings.general': N,
    'settings.integrations': F,
    'maintenance.manage': N,
    'theme.edit': N,
    'services.write': N,
    'blog.write': N,
    'portfolio.write': N,
    'pages.write': N,
    'nav.edit': N,
    'categories.manage': N,
    'content.publish': N,
    'content.archiveDelete': N,
    'seo.entityMeta': F,
    'seo.globalDefaults': F,
    'redirects.manage': F,
    'media.write': 'meta',
    'media.hardDelete': N,
    'leads.manage': N,
    'leads.pii': N,
    'export.csv': N,
    'analytics.read': F,
    'analytics.search': F,
    'ai.editContent': N,
    'ai.config': N,
    'logs.view': N,
    'logs.clear': N,
    'audit.view': N,
    'siteHealth.view': N,
    'export.backup': N,
  },
  // Developer — technical role: settings/identity/maintenance/theme, logs/audit/
  // site-health, leads management + PII + backup export. NO content authoring, NO
  // publish/schedule, NO archive/delete.
  developer: {
    'users.manage': N,
    'settings.general': F,
    'settings.integrations': N,
    'maintenance.manage': F,
    'theme.edit': F,
    'services.write': N,
    'blog.write': N,
    'portfolio.write': N,
    'pages.write': N,
    'nav.edit': N,
    'categories.manage': N,
    'content.publish': N,
    'content.archiveDelete': N,
    'seo.entityMeta': N,
    'seo.globalDefaults': N,
    'redirects.manage': N,
    'media.write': F,
    'media.hardDelete': N,
    'leads.manage': F,
    'leads.pii': F,
    'export.csv': F,
    'analytics.read': F,
    'analytics.search': F,
    'ai.editContent': N,
    'ai.config': N,
    'logs.view': F,
    'logs.clear': N,
    'audit.view': F,
    'siteHealth.view': F,
    'export.backup': F,
  },
};

/** Pure lookup of a role's access level for a capability. */
export function can(role: Role, cap: Capability): Access {
  return ROLE_CAPS[role][cap];
}

/**
 * Secondary authorization layer (RLS is primary). Throws AuthorizationError (→ 403)
 * unless `ctx` is an active session whose role grants `cap` at one of `allowed`
 * levels. Anonymous / inactive / cross-capability callers are denied. Tenant
 * scoping is enforced by RLS and by passing the resolved tenantId to every query.
 */
export function assertCap(
  ctx: AuthContext | null,
  cap: Capability,
  allowed: readonly Access[] = ['full'],
): asserts ctx is AuthContext {
  if (!ctx || !ctx.isActive) {
    throw new AuthorizationError(cap, 'no active session');
  }
  const access = ROLE_CAPS[ctx.role][cap];
  if (!allowed.includes(access)) {
    throw new AuthorizationError(cap, `role '${ctx.role}' has '${access}'`);
  }
}
