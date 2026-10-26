import type { Role } from '@/lib/auth/types';
import { can, type Access } from '@/lib/authz/matrix';
import { RESOURCES } from './resources';
import type { SeoAccess } from './editorTabs';

// What an editor screen offers a role (Admin v2 U8b), decided on the server page from the
// same ROLE_CAPS the routes enforce. UX only: the API refuses whatever the page shows.
//   canWriteResource  the role holds the resource's write capability in full: "New" on the
//                     list, and an editable form (else read-only, for a role that reads it,
//                     such as SEO on posts);
//   canReadResource   the role passes the resource's read gate (U5/U6: a page's head names
//                     a stored row only then, editorHead.ts);
//   seoAccess         the role's `seo.entityMeta`: full (edits a record's SEO), view (sees
//                     it: Content Creator) or none (no SEO tab).

export function canWriteResource(slug: string, role: Role): boolean {
  const config = RESOURCES[slug];
  return config !== undefined && can(role, config.writeCap) === 'full';
}

/**
 * The role passes the resource's read gate: any of its readCaps (else its write capability)
 * at its readAccess (else full, view or meta), exactly as its list and item GETs admit
 * (resource.ts). A server page reads a row for its head only then (editorHead.ts).
 */
export function canReadResource(slug: string, role: Role): boolean {
  const config = RESOURCES[slug];
  if (!config) return false;
  const caps = config.readCaps ?? [config.writeCap];
  const levels: readonly Access[] = config.readAccess ?? ['full', 'view', 'meta'];
  return caps.some((cap) => levels.includes(can(role, cap)));
}

export function seoAccess(role: Role): SeoAccess {
  const access = can(role, 'seo.entityMeta');
  return access === 'full' ? 'full' : access === 'none' ? 'none' : 'view';
}
