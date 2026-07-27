import type { APIRoute } from 'astro';
import { z } from 'zod';
import type { Access, Capability } from '@/lib/authz/matrix';
import { defineAdminRoute } from './route';
import { OptimisticLockError } from './errors';
import type { ResourcePayload } from './resource';

// Per-tenant singleton config rows: site_settings, site_integrations, seo_defaults,
// ai_config. Their primary key IS `tenant_id`, so the id-based CRUD helpers do not
// apply — but the two properties that matter still do, and this is where they live:
//
//   • the row is created on first write, never by a migration. Seeding one per tenant
//     in SQL means every new config column needs a backfill and every environment
//     drifts; a GET on a missing row answers with `defaults` instead.
//   • the optimistic-lock story survives that. A first write carries `version: 1` and
//     is an INSERT; a concurrent second one hits the primary key and is reported as the
//     409 it actually is, rather than a 500 about a duplicate key.

export interface SingletonConfig {
  table: string;
  /** `entity_type` in the audit log. */
  entity: string;
  readCaps: readonly Capability[];
  readAccess?: readonly Access[];
  writeCap: Capability;
  columns: string;
  schema: z.ZodTypeAny;
  toRow: (input: ResourcePayload) => Record<string, unknown>;
  /** Returned by GET when no row exists yet. */
  defaults: Record<string, unknown>;
}

export function singletonRoutes(config: SingletonConfig): { GET: APIRoute; PATCH: APIRoute } {
  const readAccess = config.readAccess ?? ['full', 'view', 'meta'];

  const GET = defineAdminRoute({
    cap: config.readCaps[0] as Capability,
    anyCap: config.readCaps,
    access: readAccess,
    handler: async ({ auth, sb }) => {
      const { data, error } = await sb
        .from(config.table)
        .select(config.columns)
        .eq('tenant_id', auth.tenantId)
        .maybeSingle();
      if (error) throw new Error(`get ${config.table}: ${error.message}`);
      return data ?? { ...config.defaults, version: 0 };
    },
  });

  const PATCH = defineAdminRoute({
    cap: config.writeCap,
    input: config.schema,
    handler: async ({ auth, sb, input, audit }) => {
      const payload = input as ResourcePayload & { version: number };
      const values = config.toRow(payload);

      const { data: existing, error: readError } = await sb
        .from(config.table)
        .select('version')
        .eq('tenant_id', auth.tenantId)
        .maybeSingle<{ version: number }>();
      if (readError) throw new Error(`read ${config.table}: ${readError.message}`);

      let row: unknown;
      if (!existing) {
        // `version: 0` is what GET reported for the not-yet-existing row, so that is
        // what a first save comes back with. Anything else means the caller is editing
        // a row that has since been created by someone else.
        if (payload.version !== 0 && payload.version !== 1) {
          throw new OptimisticLockError(config.table);
        }
        const { data, error } = await sb
          .from(config.table)
          .insert({ ...config.defaults, ...values, tenant_id: auth.tenantId })
          .select(config.columns)
          .single();
        // 23505 = someone else inserted between our read and our write.
        if (error) {
          if (error.code === '23505') throw new OptimisticLockError(config.table);
          throw new Error(`create ${config.table}: ${error.message}`);
        }
        row = data;
      } else {
        if (existing.version !== payload.version) throw new OptimisticLockError(config.table);
        const { data, error } = await sb
          .from(config.table)
          .update(values)
          .eq('tenant_id', auth.tenantId)
          .eq('version', payload.version)
          .select(config.columns)
          .maybeSingle();
        if (error) throw new Error(`update ${config.table}: ${error.message}`);
        if (!data) throw new OptimisticLockError(config.table);
        row = data;
      }

      audit({
        action: `${config.entity}.update`,
        entityType: config.entity,
        entityId: auth.tenantId,
        detail: { fields: Object.keys(values) },
      });
      return row;
    },
  });

  return { GET, PATCH };
}
