import { TestimonialUpdateSchema, TestimonialWriteSchema } from '@schemas/admin';
import { ValidationError } from '../errors';
import type { WriteRefusals } from '../crud';
import type { ResourceConfig } from '../resource';
import {
  pick,
  publishStamp,
  refusePlaceholder,
  requireBilingual,
  statusOf,
  type Input,
} from './shared';

// Testimonials (UI v2, 0021): quotes, published only with the person's recorded consent.

/**
 * The 0028 sample lock (app.tg_testimonial_sample_lock): staff can never create a design
 * sample, turn a quote into one, or change a sample's words or attribution while it stays
 * one. Its 42501 is a rule for the editor, not a missing permission — said on the field.
 * The patterns are the trigger's own messages ("… design sample …").
 */
const TESTIMONIAL_REFUSALS: WriteRefusals = [
  {
    match: /cannot be created as a design sample/i,
    field: 'isPlaceholder',
    message:
      'A new quote can’t be a design sample. Untick Placeholder and record the person’s consent.',
  },
  {
    match: /cannot be turned into a design sample/i,
    field: 'isPlaceholder',
    message: 'A real quote can’t be turned back into a design sample. Leave Placeholder unticked.',
  },
  {
    match: /design sample/i,
    field: 'isPlaceholder',
    message:
      'Sample quotes can’t be edited; replace the words, set consent and untick Placeholder in one save.',
  },
];

export const testimonialResource: ResourceConfig = {
  table: 'testimonials',
  entity: 'testimonial',
  writeCap: 'portfolio.write',
  listColumns:
    'id,slug,author_name,placements,portfolio_id,is_placeholder,status,sort_order,version,updated_at',
  columns:
    'id,slug,quote,author_name,author_role,client_id,portfolio_id,avatar_media_id,placements,' +
    'consent_obtained_at,consent_reference,is_placeholder,status,sort_order,version,' +
    'published_at,scheduled_for,created_at,updated_at',
  orderBy: { column: 'sort_order', ascending: true },
  searchColumn: 'slug',
  filterableColumns: ['portfolio_id'],
  createSchema: TestimonialWriteSchema,
  updateSchema: TestimonialUpdateSchema,
  constraintFields: {
    testimonials_consent_gate: {
      field: 'consentObtainedAt',
      message: 'record when consent was obtained before publishing or scheduling a quote',
    },
    testimonials_one_per_project: {
      field: 'portfolioId',
      message: 'that case study already has a published or scheduled quote',
    },
    testimonials_slug_check: {
      field: 'slug',
      message: 'lowercase letters, digits and hyphens, at most 64',
    },
    testimonials_tenant_id_slug_key: {
      field: 'slug',
      message: 'another quote already uses this slug',
    },
  },
  writeRefusals: TESTIMONIAL_REFUSALS,
  toRow: (input) =>
    publishStamp(
      pick(input as Input, {
        slug: 'slug',
        quote: 'quote',
        authorName: 'author_name',
        authorRole: 'author_role',
        clientId: 'client_id',
        portfolioId: 'portfolio_id',
        avatarMediaId: 'avatar_media_id',
        placements: 'placements',
        consentObtainedAt: 'consent_obtained_at',
        consentReference: 'consent_reference',
        isPlaceholder: 'is_placeholder',
        status: 'status',
        sortOrder: 'sort_order',
        scheduledFor: 'scheduled_for',
      }),
    ),
  statusOf: (input) => statusOf(input as Input),
  // The database CHECK is the gate of record for consent (every path, the cron included);
  // this says it on the field first.
  assertPublishable: (row) => {
    requireBilingual(row, 'quote', 'Quote');
    requireBilingual(row, 'author_name', 'Author name');
    refusePlaceholder(row, 'quote');
    if (!row['consent_obtained_at']) {
      throw new ValidationError(
        'record when the person agreed to be quoted before publishing',
        'consentObtainedAt',
      );
    }
  },
};
