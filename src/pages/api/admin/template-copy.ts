import { singletonRoutes } from '@/lib/admin/singleton';
import { templateCopySingleton } from '@/lib/admin/singletons/templateCopy';

// The template pages' shared text (Admin v2 E3): Admin + Content Creator (`pages.write`). The
// config lives in src/lib/admin/singletons/templateCopy.ts, where the release registry binds it
// too.

export const prerender = false;

export const { GET, PATCH } = singletonRoutes(templateCopySingleton);
