import {
  FOOTER_COLUMNS_FULL,
  FOOTER_COLUMNS_MAX,
  FOOTER_COLUMNS_PUBLISH_FIRST,
  FOOTER_HEADING_MOVE_FIRST,
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
 * The heading rows a column count reads. Hidden columns count: a column hidden today is one
 * shown tomorrow (0122).
 */
const HEADINGS = {
  columns: 'id',
  eq: { is_heading: true },
  limit: FOOTER_COLUMNS_MAX + 1,
} as const;

/**
 * The row after the write (stored or live, with the patch) holds 0122's shape, and a row that
 * BECOMES a column heading finds a place among four (E6 code review, CR3 and CR4). On every
 * write path: a save while releases are off reads live, and the database's CHECK and trigger
 * stay the last word on it. With releases on (a staged save, `db` = live with the other
 * pending changes laid over it; a release's publish and dry run, `db` = the state the release
 * leaves), the rule judges what `apply_release` (0112) passes THROUGH, so a change it accepts
 * is never refused at the apply, where it would fail its whole release (E6 release-mode check,
 * round 2):
 *   • the apply writes new and changed rows first and removals last, so a pending removal (or a
 *     column turned back into a link, in any order) frees no place for a new column in the same
 *     release: the count is live's headings, those leaving included, plus the pending ones;
 *   • it writes `parent_id` (a deferred column) in a second pass, so a link under another row
 *     made a heading in one change would reach 0122's CHECK still under it: its move is
 *     published first.
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
  const others = (rows: readonly Row[]) =>
    rows.map((h) => h['id']).filter((rowId) => rowId !== merged['id']);

  if (!ctx.db) {
    // Releases off: one write, live.
    const headings = await liveDb(ctx.sb, ctx.auth).list('navigation', HEADINGS);
    if (others(headings).length >= FOOTER_COLUMNS_MAX) {
      throw new ValidationError(FOOTER_COLUMNS_FULL, 'isHeading');
    }
    return;
  }

  // Releases on. The live row's parent, not the change's: the change's own move lands after.
  if (ctx.before != null && ctx.before['parent_id'] != null) {
    throw new ValidationError(FOOTER_HEADING_MOVE_FIRST, 'isHeading');
  }
  const [after, now] = await Promise.all([
    ctx.db.list('navigation', HEADINGS),
    (ctx.live ?? liveDb(ctx.sb, ctx.auth)).list('navigation', HEADINGS),
  ]);
  const left = new Set(others(after));
  // The peak: every heading the state left keeps, every live one (a removal lands last).
  const peak = new Set([...left, ...others(now)]);
  if (peak.size >= FOOTER_COLUMNS_MAX) {
    throw new ValidationError(
      left.size >= FOOTER_COLUMNS_MAX ? FOOTER_COLUMNS_FULL : FOOTER_COLUMNS_PUBLISH_FIRST,
      'isHeading',
    );
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
