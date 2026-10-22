import { singletonRoutes } from '@/lib/admin/singleton';
import { siteSettingsSingleton } from '@/lib/admin/singletons/siteSettings';

// General settings' technical row, `site_settings` (Admin + Developer, `settings.general`):
// the studio's time zone and the retention horizons. The config lives in
// src/lib/admin/singletons/siteSettings.ts.

export const prerender = false;

export const { GET, PATCH } = singletonRoutes(siteSettingsSingleton);
