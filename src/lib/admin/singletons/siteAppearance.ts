import {
  APPEARANCE_COLUMNS,
  appearanceColumnDefaults,
  HEADER_COLUMNS,
  SiteAppearanceWriteSchema,
} from '@schemas/appearance';
import type { SingletonConfig } from '@/lib/admin/singleton';
import { fieldsOf } from '@/lib/admin/resources/shared';
import { ValidationError } from '@/lib/admin/errors';
import { sanitizeHref } from '@/lib/content/tiptap';

// The site's appearance settings (Admin v2 E5, `public.site_appearance`, the E5 migration):
// the header's options (E5) and the loading screen's look (E7). §5 "Theme editor": Admin +
// Developer (`theme.edit`), which also publishes it once releases are on (P-2); staged like the
// theme (P-3), so with releases on the singleton kernel stages a save and with releases off it
// writes live, as every staged editor does today.
//
// A save sends what its screen shows: the Header screen every header option, the Loading screen
// every intro option (`toRow` writes only the keys a save names, so neither screen writes the
// other's columns); each option is a closed set (packages/schemas/appearance.ts) and a SQL
// CHECK holds it again.

export const siteAppearanceSingleton: SingletonConfig = {
  table: 'site_appearance',
  entity: 'site_appearance',
  // Read by the holders of theme.edit only: the menu card (nav.edit) reads navigation, never
  // this row, and the public site reads it through anon's grant.
  readCaps: ['theme.edit'],
  readAccess: ['full'],
  writeCap: 'theme.edit',
  columns: `tenant_id,${Object.values(APPEARANCE_COLUMNS).join(',')},version,updated_at`,
  schema: SiteAppearanceWriteSchema,
  // The header and the intro as built (the table's own defaults), what GET answers before the
  // first save.
  defaults: appearanceColumnDefaults(),
  toRow: (input) => {
    const out: Record<string, unknown> = {};
    for (const [key, column] of Object.entries(APPEARANCE_COLUMNS)) {
      if (input[key] !== undefined) out[column] = input[key];
    }
    // The button's link renders into `<a href>` on every public page: the menus' scheme
    // allowlist too, beside the schema's pattern (a third check is the SQL CHECK).
    const href = out[HEADER_COLUMNS.ctaHref];
    if (typeof href === 'string' && sanitizeHref(href) === null) {
      throw new ValidationError('unsupported link', 'ctaHref');
    }
    return out;
  },
  fields: fieldsOf(APPEARANCE_COLUMNS),
  // The CHECKs (the E5 migration): a value that got past the schema is a 422 on its field.
  constraintFields: {
    site_appearance_cta_href: {
      field: 'ctaHref',
      message:
        'Use a page of this site, starting with / and without /ar, or a link starting with https://',
    },
    site_appearance_cta_label: {
      field: 'ctaLabel',
      message: 'Give the button its words in both languages, up to 40 characters each.',
    },
    site_appearance_cta_complete: {
      field: 'ctaShow',
      message: 'A button that shows needs its words and its link.',
    },
    // The loading screen (E7): the tagline's words, the two timing steps and the backdrop.
    site_appearance_intro_tagline: {
      field: 'tagline',
      message: 'Give the tagline its words in both languages, up to 60 characters each.',
    },
    site_appearance_intro_hold: {
      field: 'holdMs',
      message: 'Choose a duration from 500 to 1500 ms, in steps of 100.',
    },
    site_appearance_intro_fade: {
      field: 'fadeMs',
      message: 'Choose a fade from 300 to 600 ms, in steps of 50.',
    },
    site_appearance_intro_backdrop: {
      field: 'backdrop',
      message: 'Choose one of the styles shown.',
    },
    site_appearance_tint_minimum: {
      field: 'tint',
      message:
        'A bar that stays see-through after the hero needs the darkest tint, so its links stay readable.',
    },
  },
};
