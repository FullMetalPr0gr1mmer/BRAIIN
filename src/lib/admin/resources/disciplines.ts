import { DisciplineUpdateSchema, DisciplineWriteSchema } from '@schemas/admin';
import type { ResourceConfig } from '../resource';
import {
  POSTER_LINK,
  assertLinkInTenant,
  pick,
  publishStamp,
  requireBilingual,
  statusOf,
  withPreviewField,
  withPreviewPath,
  type Input,
} from './shared';

// Disciplines (Round 2, 0028): the five groups the services are filed under.

export const disciplineResource: ResourceConfig = {
  table: 'disciplines',
  entity: 'discipline',
  // Service content (§5 "Services — create/edit": Admin + Content Creator).
  writeCap: 'services.write',
  // SEO reads services to author their meta, and the service form's Discipline picker
  // loads from here. RLS already admits every staff role (disciplines_read).
  readCaps: ['services.write', 'seo.entityMeta'],
  listColumns: 'id,slug,name,status,sort_order,version,updated_at',
  columns:
    'id,slug,name,short,blurb,poster_media_id,preview_video_path,preview_start_s,preview_end_s,' +
    'status,sort_order,version,published_at,scheduled_for,created_at,updated_at',
  orderBy: { column: 'sort_order', ascending: true },
  searchColumn: 'slug',
  createSchema: DisciplineWriteSchema,
  updateSchema: DisciplineUpdateSchema,
  constraintFields: {
    disciplines_tenant_id_slug_key: {
      field: 'slug',
      message: 'another discipline already uses this slug',
    },
    disciplines_slug_check: {
      field: 'slug',
      message: 'lowercase letters, digits and hyphens, at most 64',
    },
    disciplines_preview_video_path_check: {
      field: 'clip',
      message: 'the card clip is a /media/….mp4 file',
    },
    disciplines_preview_window: {
      field: 'clip',
      message: 'the card clip needs a start and an end, at most 30 seconds apart',
    },
    // On delete: services still point at it (on delete restrict).
    services_discipline_id_fkey: {
      message: 'services are still filed under this discipline — move or delete them first',
    },
  },
  toRow: (input) =>
    publishStamp(
      withPreviewPath(
        pick(input as Input, {
          slug: 'slug',
          name: 'name',
          short: 'short',
          blurb: 'blurb',
          posterMediaId: 'poster_media_id',
          status: 'status',
          sortOrder: 'sort_order',
          scheduledFor: 'scheduled_for',
        }),
        input as Input,
      ),
    ),
  statusOf: (input) => statusOf(input as Input),
  fromRow: withPreviewField,
  assertWritable: (_merged, ctx) => assertLinkInTenant(ctx, POSTER_LINK),
  assertPublishable: (row) => requireBilingual(row, 'name', 'Discipline name'),
};
