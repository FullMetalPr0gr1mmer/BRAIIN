import { singletonRoutes } from '@/lib/admin/singleton';
import { siteAppearanceSingleton } from '@/lib/admin/singletons/siteAppearance';

// The site's appearance settings (Admin v2 E5): Admin + Developer (`theme.edit`). The config
// lives in src/lib/admin/singletons/siteAppearance.ts, where the release registry binds it too.

export const prerender = false;

export const { GET, PATCH } = singletonRoutes(siteAppearanceSingleton);
