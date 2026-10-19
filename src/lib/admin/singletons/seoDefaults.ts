import { SeoDefaultsSchema } from '@schemas/admin';
import type { SingletonConfig } from '@/lib/admin/singleton';
import { fieldsOf } from '@/lib/admin/resources/shared';
import { SHARE_IMAGE_MISSING } from '@/lib/admin/entitySeo';

// Global SEO defaults — Admin + SEO (CLAUDE.md §5 `seo.globalDefaults`). Its own table
// rather than a column on site_settings, because site_settings is Admin + Developer and
// RLS cannot express "these columns for this role" (see migration 0009's header).
//
// Moved here from src/pages/api/admin/seo-defaults.ts (Admin v2 R2) so the release
// registry can bind it without importing a route. `toRow` now copies through one key map,
// the one `fields` is built from; what it writes is unchanged
// (tests/lib/releaseOffWrites.spec.ts).

/** Payload key → column: what `toRow` copies, and (through `fieldsOf`) its `fields`. */
const SEO_DEFAULTS_KEYS = {
  titleTemplate: 'title_template',
  defaultTitle: 'default_title',
  defaultDescription: 'default_description',
  defaultOgImage: 'default_og_image',
  // Admin v2 U10 (0073): the default share image from the media library.
  defaultOgMediaId: 'default_og_media_id',
  organization: 'organization',
  robotsDirectives: 'robots_directives',
};

export const seoDefaultsSingleton: SingletonConfig = {
  table: 'seo_defaults',
  entity: 'seo_defaults',
  readCaps: ['seo.globalDefaults'],
  readAccess: ['full'],
  writeCap: 'seo.globalDefaults',
  columns:
    'tenant_id,title_template,default_title,default_description,default_og_image,default_og_media_id,organization,robots_directives,version,updated_at',
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
    for (const [key, column] of Object.entries(SEO_DEFAULTS_KEYS)) {
      if (input[key] !== undefined) out[column] = input[key];
    }
    return out;
  },
  fields: fieldsOf(SEO_DEFAULTS_KEYS),
  // The default share image's composite key (0073): an id that names no picture of this
  // tenant is a 422 on the field.
  foreignKeys: {
    seo_defaults_default_og_media_fk: { field: 'defaultOgMediaId', message: SHARE_IMAGE_MISSING },
  },
};
