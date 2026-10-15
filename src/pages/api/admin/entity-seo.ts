import { defineAdminRoute } from '@/lib/admin/route';
import { OptimisticLockError } from '@/lib/admin/errors';
import { ENTITY_SEO } from '@/lib/admin/entitySeo';

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
//
// The columns, request shapes and payload → column mapping live in
// src/lib/admin/entitySeo.ts (Admin v2 R2), where the release registry binds them too.

export const prerender = false;

const { COLUMNS, LookupSchema, WriteSchema, DEFAULTS } = ENTITY_SEO;

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
    ENTITY_SEO.assertBilingual(input);
    const values = ENTITY_SEO.toRow(input);

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
        .insert({ ...values, tenant_id: auth.tenantId, ...ENTITY_SEO.target(input) })
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
