import { ServiceCaseUpdateSchema, ServiceCaseWriteSchema } from '@schemas/admin';
import type { ResourceConfig } from '../resource';
import {
  assertLinkInTenant,
  pick,
  publishStamp,
  refusePlaceholder,
  refusePlaceholderFigures,
  requireBilingual,
  statusOf,
  type Input,
} from './shared';

// Service case studies (Round 2, 0028): one block per service page, linked to a project.

export const serviceCaseResource: ResourceConfig = {
  table: 'service_cases',
  entity: 'service_case',
  writeCap: 'services.write',
  listColumns: 'id,service_id,portfolio_id,title,is_placeholder,status,version,updated_at',
  columns:
    'id,service_id,portfolio_id,title,context,problems,results,is_placeholder,status,version,' +
    'published_at,scheduled_for,created_at,updated_at',
  orderBy: { column: 'updated_at', ascending: false },
  searchColumn: 'title->>en',
  filterableColumns: ['service_id', 'portfolio_id'],
  createSchema: ServiceCaseWriteSchema,
  updateSchema: ServiceCaseUpdateSchema,
  constraintFields: {
    service_cases_tenant_id_service_id_key: {
      field: 'serviceId',
      message: 'that service already has a case study block — edit that one instead',
    },
    service_cases_service_id_fkey: { field: 'serviceId', message: 'that service does not exist' },
    service_cases_portfolio_id_fkey: {
      field: 'portfolioId',
      message: 'that project does not exist',
    },
  },
  toRow: (input) =>
    publishStamp(
      pick(input as Input, {
        serviceId: 'service_id',
        portfolioId: 'portfolio_id',
        title: 'title',
        context: 'context',
        problems: 'problems',
        results: 'results',
        isPlaceholder: 'is_placeholder',
        status: 'status',
        scheduledFor: 'scheduled_for',
      }),
    ),
  statusOf: (input) => statusOf(input as Input),
  // The database fences both links too (service_cases_write); this says which field.
  assertWritable: async (_merged, ctx) => {
    await assertLinkInTenant(ctx, {
      column: 'service_id',
      table: 'services',
      field: 'serviceId',
      message: 'that service does not exist on this site',
    });
    await assertLinkInTenant(ctx, {
      column: 'portfolio_id',
      table: 'portfolio',
      field: 'portfolioId',
      message: 'that project does not exist on this site',
    });
  },
  // The design delivery's 28 case blocks are samples: live only under the owner's audited
  // override (runbook §6d), never published through the admin.
  assertPublishable: (row) => {
    requireBilingual(row, 'title', 'Case study title');
    refusePlaceholder(row, 'case study block');
    refusePlaceholderFigures(row);
  },
};
