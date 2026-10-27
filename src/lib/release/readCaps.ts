import type { Capability } from '@/lib/authz/matrix';

// The capabilities that read a release-managed area (Admin v2 R13): the union of every
// registry entry's read capabilities, which the pending summary, the versions list, the
// history and the preview admit (`PENDING_ANY_CAP`, `PREVIEW_READ_CAPS`, both derived from
// src/lib/release/registry.ts, which is SERVER ONLY). Written out here so the menu
// (src/lib/admin/nav/settings.ts: Backups & versions, plan B7.3), which the browser loads too,
// can name them without the registry and its resource configs; tests/lib/versionsPage.spec.ts
// holds this list equal to the derived one, so a registry change moves it or fails.

export const RELEASE_READ_CAPS: readonly Capability[] = [
  'blog.write',
  'categories.manage',
  'maintenance.manage',
  'nav.edit',
  'pages.write',
  'portfolio.write',
  'redirects.manage',
  'seo.entityMeta',
  'seo.globalDefaults',
  'services.write',
  'settings.general',
  'theme.edit',
];
