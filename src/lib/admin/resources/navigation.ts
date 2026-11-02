import { FOOTER_COLUMNS_MAX, NavItemUpdateSchema, NavItemWriteSchema } from '@schemas/admin';
import { sanitizeHref } from '@/lib/content/tiptap';
import { ValidationError } from '../errors';
import type { ResourceConfig } from '../resource';
import { fieldsOf, pick, type Input } from './shared';

// Navigation: the header and footer menus.

const NAV_KEYS = {
  location: 'location',
  parentId: 'parent_id',
  label: 'label',
  href: 'href',
  visible: 'visible',
  isKey: 'is_key',
  sortOrder: 'sort_order',
  // Admin v2 E6: a footer column's heading (no link; 0122's CHECK and four-column trigger).
  isHeading: 'is_heading',
};

export const navigationResource: ResourceConfig = {
  table: 'navigation',
  entity: 'nav_item',
  writeCap: 'nav.edit',
  // `visible` is a menu link's go-live flag (app.release_entities.publish_flag, 0038):
  // turning it on is gated like a publish (content.publish). Every holder of nav.edit
  // holds content.publish (Admin, Content Creator), and navigation has no
  // assertPublishable, so no request changes outcome (Admin v2 R2, D5;
  // tests/lib/releaseCaps.spec.ts holds the holder sets).
  publishFlag: 'visible',
  listColumns: 'id,location,parent_id,label,href,visible,is_key,is_heading,sort_order,version',
  columns:
    'id,location,parent_id,label,href,visible,is_key,is_heading,sort_order,version,created_at,updated_at',
  orderBy: { column: 'sort_order', ascending: true },
  filterableColumns: ['location'],
  createSchema: NavItemWriteSchema,
  updateSchema: NavItemUpdateSchema,
  constraintFields: {
    navigation_one_key_per_location: {
      field: 'isKey',
      message: 'This menu already has a key link — untick it there first, then tick this one.',
    },
    // Admin v2 E6 (0122): what the database refuses about a column heading, said on the field
    // a person changes to fix it (an update names only what it changes, so the shape is
    // checked against the stored row there).
    navigation_heading_shape: {
      field: 'isHeading',
      message:
        'A column heading has no link, sits at the top of the footer and is never the key link. A link needs its address.',
    },
    navigation_footer_columns_max: {
      field: 'isHeading',
      message: `The footer already has ${FOOTER_COLUMNS_MAX} columns. Remove one or turn it back into a link first.`,
    },
  },
  toRow: (input) => {
    const values = pick(input as Input, NAV_KEYS);
    // A column heading's link is empty (null): there is nothing to sanitise.
    if ('href' in values && values['href'] != null) {
      // Nav links render into `<a href>` on every public page. Same scheme allowlist as
      // rich-text links, because a `javascript:` nav item would be sitewide, not
      // confined to one article.
      const href = sanitizeHref(values['href']);
      if (!href) throw new ValidationError('unsupported link scheme', 'href');
      values['href'] = href;
    }
    return values;
  },
  // `href` is sanitised in place: still the one column.
  fields: fieldsOf(NAV_KEYS),
};
