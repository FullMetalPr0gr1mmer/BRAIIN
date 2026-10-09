import { ServiceUpdateSchema, ServiceWriteSchema } from '@schemas/admin';
import { ValidationError } from '../errors';
import type { ConstraintFields } from '../crud';
import type { ResourceConfig } from '../resource';
import {
  POSTER_LINK,
  assertLinkInTenant,
  pick,
  publishStamp,
  requireBilingual,
  statusOf,
  withBodyHtml,
  withPreviewField,
  withPreviewPath,
  type Input,
} from './shared';

// Services (Round 2, 0028): each filed under a discipline, with a poster and a clip window.

const SERVICE_CONSTRAINTS: ConstraintFields = {
  services_tenant_id_slug_key: { field: 'slug', message: 'another service already uses this slug' },
  services_intro_check: { field: 'intro', message: 'the intro needs English and Arabic' },
  services_value_points_check: { field: 'valuePoints', message: 'at most 6 value cards' },
  services_deliverables_check: { field: 'deliverables', message: 'at most 12 lines' },
  services_preview_video_path_check: {
    field: 'clip',
    message: 'the hero clip is a /media/….mp4 file',
  },
  services_preview_window: {
    field: 'clip',
    message: 'the hero clip needs a start and an end, at most 30 seconds apart',
  },
  services_discipline_id_fkey: { field: 'disciplineId', message: 'that discipline does not exist' },
};

export const serviceResource: ResourceConfig = {
  table: 'services',
  entity: 'service',
  writeCap: 'services.write',
  // SEO can list/read a service to author its meta, but not write the row itself.
  readCaps: ['services.write', 'seo.entityMeta'],
  listColumns: 'id,slug,title,status,is_teaser,sort_order,discipline_id,version,updated_at',
  columns:
    'id,slug,title,short_title,blurb,body,body_html,hero_video_uid,category,status,is_teaser,' +
    'sort_order,version,published_at,scheduled_for,created_at,updated_at,discipline_id,intro,' +
    'value_points,deliverables,poster_media_id,preview_video_path,preview_start_s,preview_end_s',
  orderBy: { column: 'sort_order', ascending: true },
  searchColumn: 'slug',
  // The service-case editor lists the services of one discipline.
  filterableColumns: ['discipline_id'],
  createSchema: ServiceWriteSchema,
  updateSchema: ServiceUpdateSchema,
  constraintFields: SERVICE_CONSTRAINTS,
  toRow: (input) =>
    publishStamp(
      withPreviewPath(
        withBodyHtml(
          pick(input as Input, {
            slug: 'slug',
            title: 'title',
            blurb: 'blurb',
            body: 'body',
            heroVideoUid: 'hero_video_uid',
            category: 'category',
            shortTitle: 'short_title',
            status: 'status',
            isTeaser: 'is_teaser',
            sortOrder: 'sort_order',
            scheduledFor: 'scheduled_for',
            disciplineId: 'discipline_id',
            intro: 'intro',
            valuePoints: 'value_points',
            deliverables: 'deliverables',
            posterMediaId: 'poster_media_id',
          }),
          input as Input,
        ),
        input as Input,
      ),
    ),
  statusOf: (input) => statusOf(input as Input),
  fromRow: withPreviewField,
  assertWritable: async (_merged, ctx) => {
    await assertLinkInTenant(ctx, {
      column: 'discipline_id',
      table: 'disciplines',
      field: 'disciplineId',
      message: 'that discipline does not exist on this site',
    });
    await assertLinkInTenant(ctx, POSTER_LINK);
  },
  assertPublishable: (row) => {
    requireBilingual(row, 'title', 'Service title');
    // Not a database CHECK: the production cut-over renames services before their
    // disciplines exist (runbook §6d). Every live service is filed under one.
    if (!row['discipline_id']) {
      throw new ValidationError('choose the discipline before publishing', 'disciplineId');
    }
  },
};
