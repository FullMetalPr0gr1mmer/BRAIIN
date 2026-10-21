import type { Role } from '@/lib/auth/types';
import { can } from '@/lib/authz/matrix';
import { RESOURCES } from './resources';
import type { SeoAccess } from './editorTabs';

// What an editor screen offers a role (Admin v2 U8b), decided on the server page from the
// same ROLE_CAPS the routes enforce. UX only: the API refuses whatever the page shows.
//   canWriteResource  the role holds the resource's write capability in full: "New" on the
//                     list, and an editable form (else read-only, for a role that reads it,
//                     such as SEO on posts);
//   seoAccess         the role's `seo.entityMeta`: full (edits a record's SEO), view (sees
//                     it: Content Creator) or none (no SEO tab).

export function canWriteResource(slug: string, role: Role): boolean {
  const config = RESOURCES[slug];
  return config !== undefined && can(role, config.writeCap) === 'full';
}

export function seoAccess(role: Role): SeoAccess {
  const access = can(role, 'seo.entityMeta');
  return access === 'full' ? 'full' : access === 'none' ? 'none' : 'view';
}
