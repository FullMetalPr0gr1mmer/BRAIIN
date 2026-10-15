import { singletonRoutes } from '@/lib/admin/singleton';
import { siteProfileSingleton } from '@/lib/admin/singletons/siteProfile';

// The public identity, `site_profile` (Admin + Developer, `settings.general`). The config,
// with the Admin-only intake switch's Worker guard and why it exists, lives in
// src/lib/admin/singletons/siteProfile.ts, where the release registry binds it too.

export const prerender = false;

export const { GET, PATCH } = singletonRoutes(siteProfileSingleton);
