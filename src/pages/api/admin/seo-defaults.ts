import { SeoDefaultsSchema } from '@schemas/admin';
import { singletonRoutes } from '@/lib/admin/singleton';

// Global SEO defaults — Admin + SEO (CLAUDE.md §5 `seo.globalDefaults`). Its own table
// rather than a column on site_settings, because site_settings is Admin + Developer and
// RLS cannot express "these columns for this role" (see migration 0009's header).

export const prerender = false;

export const { GET, PATCH } = singletonRoutes({
  table: 'seo_defaults',
  entity: 'seo_defaults',
  readCaps: ['seo.globalDefaults'],
  readAccess: ['full'],
  writeCap: 'seo.globalDefaults',
  columns:
    'tenant_id,title_template,default_title,default_description,default_og_image,organization,robots_directives,version,updated_at',
  schema: SeoDefaultsSchema,
  defaults: {
    title_template: {},
    default_title: {},
    default_description: {},
    organization: {},
    robots_directives: 'index,follow',
  },
  toRow: (input) => {
    const out: Record<string, unknown> = {};
    if (input['titleTemplate'] !== undefined) out['title_template'] = input['titleTemplate'];
    if (input['defaultTitle'] !== undefined) out['default_title'] = input['defaultTitle'];
    if (input['defaultDescription'] !== undefined) {
      out['default_description'] = input['defaultDescription'];
    }
    if (input['defaultOgImage'] !== undefined) out['default_og_image'] = input['defaultOgImage'];
    if (input['organization'] !== undefined) out['organization'] = input['organization'];
    if (input['robotsDirectives'] !== undefined) {
      out['robots_directives'] = input['robotsDirectives'];
    }
    return out;
  },
});
