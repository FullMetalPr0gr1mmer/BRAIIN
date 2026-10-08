import { NavItemUpdateSchema, NavItemWriteSchema } from '@schemas/admin';
import { sanitizeHref } from '@/lib/content/tiptap';
import { ValidationError } from '../errors';
import type { ResourceConfig } from '../resource';
import { pick, type Input } from './shared';

// Navigation: the header and footer menus.

export const navigationResource: ResourceConfig = {
  table: 'navigation',
  entity: 'nav_item',
  writeCap: 'nav.edit',
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
    const values = pick(input as Input, {
      location: 'location',
      parentId: 'parent_id',
      label: 'label',
      href: 'href',
      visible: 'visible',
      isKey: 'is_key',
      sortOrder: 'sort_order',
    });
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
};
