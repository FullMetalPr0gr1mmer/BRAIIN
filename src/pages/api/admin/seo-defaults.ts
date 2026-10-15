import { singletonRoutes } from '@/lib/admin/singleton';
import { seoDefaultsSingleton } from '@/lib/admin/singletons/seoDefaults';

// Global SEO defaults — Admin + SEO (`seo.globalDefaults`). The config lives in
// src/lib/admin/singletons/seoDefaults.ts, where the release registry binds it too.

export const prerender = false;

export const { GET, PATCH } = singletonRoutes(seoDefaultsSingleton);
