import { AiStyleUpdateSchema, AiStyleWriteSchema } from '@schemas/admin';
import type { ResourceConfig } from '../resource';
import { pick, requireBilingual, statusOf, type Input } from './shared';

// AI Style-Finder authoring: the styles.

export const aiStyleResource: ResourceConfig = {
  table: 'ai_styles',
  entity: 'ai_style',
  writeCap: 'ai.editContent',
  listColumns: 'id,slug,name,status,sort_order,version,updated_at',
  columns:
    'id,slug,name,description,traits,image_url,status,sort_order,version,created_at,updated_at',
  orderBy: { column: 'sort_order', ascending: true },
  searchColumn: 'slug',
  createSchema: AiStyleWriteSchema,
  updateSchema: AiStyleUpdateSchema,
  toRow: (input) =>
    pick(input as Input, {
      slug: 'slug',
      name: 'name',
      description: 'description',
      traits: 'traits',
      imageUrl: 'image_url',
      status: 'status',
      sortOrder: 'sort_order',
    }),
  statusOf: (input) => statusOf(input as Input),
  assertPublishable: (row) => requireBilingual(row, 'name', 'Style name'),
};
