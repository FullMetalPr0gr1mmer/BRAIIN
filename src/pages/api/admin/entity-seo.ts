import { z } from 'zod';
import { EntitySeoWriteSchema } from '@schemas/admin';
import { defineAdminRoute } from '@/lib/admin/route';
import { OptimisticLockError, ValidationError } from '@/lib/admin/errors';

// Per-entity SEO metadata (`seo.entityMeta` — Admin + SEO write, Content Creator view).
//
// Keyed by (entity_type, entity_id) rather than its own id, because the row is a
// property OF a service/post/case-study/page: the caller always knows what it is
// editing the meta for, and never a separate identifier it would have to look up first.
//
// The write path is an explicit read-then-insert-or-update instead of PostgREST's
// `upsert`. Upsert here would need the caller to send `id`, and a caller who can send
// `id` can point a valid (entity_type, entity_id) payload at SOMEONE ELSE'S row —
// exactly the kind of key confusion the tenant predicate exists to prevent.

export const prerender = false;

const COLUMNS =
  'id,entity_type,entity_id,meta_title,meta_description,og_image,canonical_override,robots,schema_type,version,updated_at';

const LookupSchema = z.object({
  entityType: z.enum(['service', 'blog_post', 'portfolio', 'page']),
  entityId: z.string().uuid(),
});

const WriteSchema = EntitySeoWriteSchema.extend({ version: z.number().int().min(0) });

const DEFAULTS = {
  meta_title: {},
  meta_description: {},
  og_image: null,
  canonical_override: null,
  robots: null,
  schema_type: null,
  version: 0,
};

export const GET = defineAdminRoute({
  cap: 'seo.entityMeta',
  // Content Creator holds 'view' — it can read the meta attached to a post it wrote,
  // and the PUT below still refuses its writes.
  access: ['full', 'view'],
  input: LookupSchema,
  handler: async ({ auth, sb, input }) => {
    const { data, error } = await sb
      .from('entity_seo')
      .select(COLUMNS)
      .eq('tenant_id', auth.tenantId)
      .eq('entity_type', input.entityType)
      .eq('entity_id', input.entityId)
      .maybeSingle();
    if (error) throw new Error(`read entity_seo: ${error.message}`);
    return (
      data ?? { ...DEFAULTS, entity_type: input.entityType, entity_id: input.entityId, id: null }
    );
  },
});

export const PUT = defineAdminRoute({
  cap: 'seo.entityMeta',
  access: ['full'],
  input: WriteSchema,
  handler: async ({ auth, sb, input, audit }) => {
    // Both meta fields are bilingual-required by the schema. Restated as a domain check
    // because CI blocks empty `meta_*_ar` (Pillar 3) and the error message an editor
    // sees should name the problem, not read like a schema dump.
    if (!input.metaTitle.ar || !input.metaDescription.ar) {
      throw new ValidationError('Arabic meta title and description are required', 'metaTitle.ar');
    }

    const values = {
      meta_title: input.metaTitle,
      meta_description: input.metaDescription,
      og_image: input.ogImage ?? null,
      canonical_override: input.canonicalOverride ?? null,
      robots: input.robots ?? null,
      schema_type: input.schemaType ?? null,
    };

    const { data: existing, error: readError } = await sb
      .from('entity_seo')
      .select('id,version')
      .eq('tenant_id', auth.tenantId)
      .eq('entity_type', input.entityType)
      .eq('entity_id', input.entityId)
      .maybeSingle<{ id: string; version: number }>();
    if (readError) throw new Error(`read entity_seo: ${readError.message}`);

    let row: unknown;
    if (!existing) {
      if (input.version !== 0 && input.version !== 1) throw new OptimisticLockError('entity_seo');
      const { data, error } = await sb
        .from('entity_seo')
        .insert({
          ...values,
          tenant_id: auth.tenantId,
          entity_type: input.entityType,
          entity_id: input.entityId,
        })
        .select(COLUMNS)
        .single();
      if (error) {
        if (error.code === '23505') throw new OptimisticLockError('entity_seo');
        throw new Error(`create entity_seo: ${error.message}`);
      }
      row = data;
    } else {
      if (existing.version !== input.version) throw new OptimisticLockError('entity_seo');
      const { data, error } = await sb
        .from('entity_seo')
        .update(values)
        .eq('tenant_id', auth.tenantId)
        .eq('id', existing.id)
        .eq('version', input.version)
        .select(COLUMNS)
        .maybeSingle();
      if (error) throw new Error(`update entity_seo: ${error.message}`);
      if (!data) throw new OptimisticLockError('entity_seo');
      row = data;
    }

    audit({
      action: 'entity_seo.update',
      entityType: 'entity_seo',
      entityId: input.entityId,
      detail: { target: input.entityType },
    });
    return row;
  },
});
