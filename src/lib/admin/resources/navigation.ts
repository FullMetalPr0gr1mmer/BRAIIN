import {
  FOOTER_COLUMNS_FULL,
  FOOTER_COLUMNS_MAX,
  navShapeIssues,
  NavItemUpdateSchema,
  NavItemWriteSchema,
  type NavShape,
} from '@schemas/admin';
import { sanitizeHref } from '@/lib/content/tiptap';
import { liveDb } from '@/lib/release/overlayDb';
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

type Row = Record<string, unknown>;

/** The shape's columns of a row, by payload name (navShapeIssues reads those). */
const SHAPE_KEYS = ['isHeading', 'href', 'location', 'parentId', 'isKey'] as const;

const shapeOf = (row: Row): NavShape =>
  Object.fromEntries(SHAPE_KEYS.map((key) => [key, row[NAV_KEYS[key]]])) as NavShape;

/**
 * The row after the write (stored or live, with the patch) holds 0122's shape, and a row that
 * BECOMES a column heading finds a place among four (E6 code review, CR3 and CR4). On every
 * write path: a save while releases are off reads live; a staged save reads live with the
 * other pending changes laid over it (`db`, R6), so a fifth column is refused when it is
 * staged, not when its release is applied; a publish and its dry run judge the state the
 * release leaves. The database's CHECK and trigger stay the last word on a live write.
 */
async function assertNavWritable(
  merged: Row,
  ctx: Parameters<NonNullable<ResourceConfig['assertWritable']>>[1],
): Promise<void> {
  const changed = new Set(SHAPE_KEYS.filter((key) => NAV_KEYS[key] in ctx.changed)) as ReadonlySet<
    keyof NavShape
  >;
  // A create judges the whole row; an update only what it can have broken.
  const [issue] = navShapeIssues(shapeOf(merged), ctx.before === null ? undefined : changed);
  if (issue) throw new ValidationError(issue.message, issue.field);

  if (merged['is_heading'] !== true) return;
  // Already a heading before this write: it holds its place (0122's trigger says the same).
  const was =
    ctx.before === undefined ? !('is_heading' in ctx.changed) : ctx.before?.['is_heading'] === true;
  if (was) return;
  // Hidden columns count: a column hidden today is one shown tomorrow (0122).
  const headings = await (ctx.db ?? liveDb(ctx.sb, ctx.auth)).list('navigation', {
    columns: 'id',
    eq: { is_heading: true },
    limit: FOOTER_COLUMNS_MAX + 1,
  });
  if (headings.filter((h) => h['id'] !== merged['id']).length >= FOOTER_COLUMNS_MAX) {
    throw new ValidationError(FOOTER_COLUMNS_FULL, 'isHeading');
  }
}

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
    // Admin v2 E6 (0122): what the database refuses about a column heading. assertNavWritable
    // says each clash first, on the field to fix (E6 code review, CR4); these two are the
    // database's last word, for a write that raced the Worker's read.
    navigation_heading_shape: {
      field: 'isHeading',
      message:
        'A column heading has no link, sits at the top of the footer and is never the key link. A link needs its address.',
    },
    navigation_footer_columns_max: { field: 'isHeading', message: FOOTER_COLUMNS_FULL },
    // A parent is keyed with its tenant (0122, review E6-SEC-1): a row of another site's
    // menus is refused as if it did not exist.
    navigation_parent_fk: {
      field: 'parentId',
      message: 'That column or link is not in this site’s menus. Choose another one.',
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
  assertWritable: assertNavWritable,
};
