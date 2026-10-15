import { SectorUpdateSchema, SectorWriteSchema } from '@schemas/admin';
import type { ResourceConfig } from '../resource';
import { fieldsOf, pick, type Input } from './shared';

// Sectors (UI v2, 0021): the industries a case study is filed under.

const SECTOR_KEYS = {
  slug: 'slug',
  name: 'name',
  visible: 'visible',
  sortOrder: 'sort_order',
};

export const sectorResource: ResourceConfig = {
  table: 'sectors',
  entity: 'sector',
  // A taxonomy, like categories (§5 "Categories management": Admin + Content Creator).
  writeCap: 'categories.manage',
  // seo.entityMeta: SEO reviews a case study (portfolio readCaps) and its Industry picker
  // loads from here. RLS already admits every staff role (sectors_read).
  readCaps: ['categories.manage', 'portfolio.write', 'seo.entityMeta'],
  listColumns: 'id,slug,name,visible,sort_order,version,updated_at',
  columns: 'id,slug,name,visible,sort_order,version,created_at,updated_at',
  orderBy: { column: 'sort_order', ascending: true },
  searchColumn: 'slug',
  createSchema: SectorWriteSchema,
  updateSchema: SectorUpdateSchema,
  toRow: (input) => pick(input as Input, SECTOR_KEYS),
  fields: fieldsOf(SECTOR_KEYS),
  // `visible` is the sector's go-live flag (app.release_entities.publish_flag, 0038), as
  // it is for clients: turning it on is gated like a publish (content.publish). Every
  // holder of categories.manage holds content.publish (Admin, Content Creator), and
  // sectors have no assertPublishable, so no request changes outcome (Admin v2 R2, D5;
  // tests/lib/releaseCaps.spec.ts holds the holder sets).
  publishFlag: 'visible',
  constraintFields: {
    sectors_slug_check: {
      field: 'slug',
      message: 'lowercase letters, digits and hyphens, at most 64',
    },
    sectors_tenant_id_slug_key: { field: 'slug', message: 'another sector already uses this slug' },
  },
};
