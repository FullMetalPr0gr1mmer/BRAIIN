import { NavItemUpdateSchema, NavItemWriteSchema } from '@schemas/admin';
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
  listColumns: 'id,location,parent_id,label,href,visible,is_key,sort_order,version',
  columns:
    'id,location,parent_id,label,href,visible,is_key,sort_order,version,created_at,updated_at',
  orderBy: { column: 'sort_order', ascending: true },
  filterableColumns: ['location'],
  createSchema: NavItemWriteSchema,
  updateSchema: NavItemUpdateSchema,
  constraintFields: {
    navigation_one_key_per_location: {
      field: 'isKey',
      message: 'This menu already has a key link — untick it there first, then tick this one.',
    },
  },
  toRow: (input) => {
    const values = pick(input as Input, NAV_KEYS);
    if ('href' in values) {
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
