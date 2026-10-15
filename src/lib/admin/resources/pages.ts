import { PageUpdateSchema, PageWriteSchema } from '@schemas/admin';
import type { ResourceConfig } from '../resource';
import {
  STAMPED,
  fieldsOf,
  pick,
  publishStamp,
  requireBilingual,
  statusOf,
  type Input,
} from './shared';

// Pages.

const PAGE_KEYS = {
  slug: 'slug',
  title: 'title',
  status: 'status',
  navVisible: 'nav_visible',
  scheduledFor: 'scheduled_for',
};

export const pageResource: ResourceConfig = {
  table: 'pages',
  entity: 'page',
  writeCap: 'pages.write',
  readCaps: ['pages.write', 'seo.entityMeta', 'maintenance.manage'],
  listColumns: 'id,slug,title,status,nav_visible,version,updated_at',
  columns:
    'id,slug,title,status,nav_visible,version,published_at,scheduled_for,created_at,updated_at',
  orderBy: { column: 'slug', ascending: true },
  searchColumn: 'slug',
  createSchema: PageWriteSchema,
  updateSchema: PageUpdateSchema,
  toRow: (input) => publishStamp(pick(input as Input, PAGE_KEYS)),
  fields: fieldsOf(PAGE_KEYS, STAMPED),
  statusOf: (input) => statusOf(input as Input),
  assertPublishable: (row) => requireBilingual(row, 'title', 'Page title'),
};
