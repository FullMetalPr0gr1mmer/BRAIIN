import { singletonRoutes } from '@/lib/admin/singleton';
import { formSettingsSingleton } from '@/lib/admin/singletons/formSettings';

// The forms config (Admin v2 E8): Admin + Developer (`settings.general`). The config lives
// in src/lib/admin/singletons/formSettings.ts, where the release registry binds it too.

export const prerender = false;

export const { GET, PATCH } = singletonRoutes(formSettingsSingleton);
