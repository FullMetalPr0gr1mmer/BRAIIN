import { CategoryUpdateSchema, CategoryWriteSchema } from '@schemas/admin';
import type { ResourceConfig } from '../resource';
import { fieldsOf, pick, type Input } from './shared';

// Blog categories.

/** Payload key → column: what `toRow` picks, and (through `fieldsOf`) its `fields`. */
const CATEGORY_KEYS = { slug: 'slug', name: 'name' };

export const categoryResource: ResourceConfig = {
  table: 'categories',
  entity: 'category',
  writeCap: 'categories.manage',
  readCaps: ['categories.manage', 'blog.write', 'seo.entityMeta'],
  listColumns: 'id,slug,name,version',
  columns: 'id,slug,name,version,created_at,updated_at',
  orderBy: { column: 'slug', ascending: true },
  searchColumn: 'slug',
  createSchema: CategoryWriteSchema,
  updateSchema: CategoryUpdateSchema,
  toRow: (input) => pick(input as Input, CATEGORY_KEYS),
  fields: fieldsOf(CATEGORY_KEYS),
};
