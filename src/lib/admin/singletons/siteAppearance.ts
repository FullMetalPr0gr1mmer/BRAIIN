import { HEADER_COLUMNS, SiteAppearanceWriteSchema } from '@schemas/appearance';
import type { SingletonConfig } from '@/lib/admin/singleton';
import { fieldsOf } from '@/lib/admin/resources/shared';
import { ValidationError } from '@/lib/admin/errors';
import { sanitizeHref } from '@/lib/content/tiptap';

// The site's appearance settings (Admin v2 E5, `public.site_appearance`, the E5 migration):
// the header's options today, the loading screen's from E7. §5 "Theme editor": Admin +
// Developer (`theme.edit`), which also publishes it once releases are on (P-2); staged like the
// theme (P-3), so with releases on the singleton kernel stages a save and with releases off it
// writes live, as every staged editor does today.
//
// A save sends the whole header (the editor shows every option); each option is a closed set
// (packages/schemas/appearance.ts) and a SQL CHECK holds it again.

export const siteAppearanceSingleton: SingletonConfig = {
  table: 'site_appearance',
  entity: 'site_appearance',
  // Read by the holders of theme.edit only: the menu card (nav.edit) reads navigation, never
  // this row, and the public site reads it through anon's grant.
  readCaps: ['theme.edit'],
  readAccess: ['full'],
  writeCap: 'theme.edit',
  columns: `tenant_id,${Object.values(HEADER_COLUMNS).join(',')},version,updated_at`,
  schema: SiteAppearanceWriteSchema,
  // The header as built (the table's own defaults), what GET answers before the first save.
  defaults: {
    header_logo_position: 'start',
    header_logo_size: 'm',
    header_menu_align: 'center',
    header_sticky: true,
    header_hide_on_scroll: true,
    header_solid_after_hero: true,
    header_tint: 'none',
    header_blur: 'soft',
    header_mobile_menu: 'drawer',
    header_cta_show: false,
    header_cta_label: null,
    header_cta_href: null,
  },
  toRow: (input) => {
    const out: Record<string, unknown> = {};
    for (const [key, column] of Object.entries(HEADER_COLUMNS)) {
      if (input[key] !== undefined) out[column] = input[key];
    }
    // The button's link renders into `<a href>` on every public page: the menus' scheme
    // allowlist too, beside the schema's pattern (a third check is the SQL CHECK).
    const href = out['header_cta_href'];
    if (typeof href === 'string' && sanitizeHref(href) === null) {
      throw new ValidationError('unsupported link', 'ctaHref');
    }
    return out;
  },
  fields: fieldsOf(HEADER_COLUMNS),
  // The CHECKs (the E5 migration): a value that got past the schema is a 422 on its field.
  constraintFields: {
    site_appearance_cta_href: {
      field: 'ctaHref',
      message: 'Use a page of this site, starting with /, or a link starting with https://',
    },
    site_appearance_cta_label: {
      field: 'ctaLabel',
      message: 'Give the button its words in both languages, up to 40 characters each.',
    },
    site_appearance_cta_complete: {
      field: 'ctaShow',
      message: 'A button that shows needs its words and its link.',
    },
    site_appearance_tint_minimum: {
      field: 'tint',
      message:
        'A bar that stays see-through after the hero needs the darkest tint, so its links stay readable.',
    },
  },
};
