import type { APIRoute } from 'astro';
import { z } from 'zod';
import type { ContentStatus } from '@schemas/primitives';
import { ListQuerySchema } from '@schemas/admin';
import type { AuthContext } from '@/lib/auth/types';
import { assertCap, type Access, type Capability } from '@/lib/authz/matrix';
import { defineAdminRoute, json } from './route';
import { assertStatusTransition, deleteRow, getRow, insertRow, listRows, updateRow } from './crud';
import { NotFoundError, ValidationError } from './errors';

// A declarative CRUD resource. Fifteen entities in this CMS have the same lifecycle —
// list, read, create, optimistically update, delete — differing only in table name,
// column mapping and which capability guards them.
//
// Writing those fifteen by hand would produce fifteen chances to forget the tenant
// predicate, the status-transition check, or the audit row. The point of this factory
// is that those three are structural: an endpoint cannot opt out of them, because it
// does not implement them.
//
// What a resource does NOT get to customise:
//   • the tenant predicate (crud.ts, always)
//   • assertCap / assertAnyCap (below, always)
//   • the audit row on every mutation (below, always)
//   • the optimistic-lock guard on update (crud.ts, always)

// The payload types are intentionally `Record<string, unknown>` rather than the
// schemas' inferred shapes. `toRow` is a dynamic key→column mapping, so it gains
// nothing from the precise type, and parameterising the config on it would force every
// entry in resources.ts to restate two long inferred types — which does not typecheck
// anyway, because a Zod schema with `.default()` has an INPUT type where those fields
// are optional and an OUTPUT type where they are not. The real safety here is the
// allowlist in `pick()`: unknown keys never reach SQL regardless of what TypeScript
// believes about them.
export type ResourcePayload = Record<string, unknown>;

export interface ResourceConfig {
  /** Postgres table. */
  table: string;
  /** `entity_type` in audit_log and content_versions. */
  entity: string;
  /** Capability required to WRITE. */
  writeCap: Capability;
  /**
   * Capabilities that grant READ. Any one of them at `readAccess` suffices — see
   * assertAnyCap. Defaults to `[writeCap]`.
   */
  readCaps?: readonly Capability[];
  readAccess?: readonly Access[];
  /** Columns returned by list endpoints. */
  listColumns: string;
  /** Columns returned by single-row endpoints. */
  columns: string;
  orderBy: { column: string; ascending?: boolean };
  /** Column used by `?q=` substring search, if the resource supports it. */
  searchColumn?: string;
  /** Extra equality filters accepted from the list query. */
  filterableColumns?: readonly string[];
  createSchema: z.ZodTypeAny;
  updateSchema: z.ZodTypeAny;
  /** camelCase input → snake_case column patch. Only listed keys ever reach SQL. */
  toRow: (input: ResourcePayload) => Record<string, unknown>;
  /** Lifecycle status of an incoming payload, when the entity has one. */
  statusOf?: (input: ResourcePayload) => ContentStatus | undefined;
  /** Domain rules that must hold before a row may be published. */
  assertPublishable?: (row: Record<string, unknown>) => void;
  /** Runs after a successful write (cache purge, derived rows). Never fatal. */
  afterWrite?: (ctx: {
    auth: AuthContext;
    sb: import('@supabase/supabase-js').SupabaseClient;
    row: Record<string, unknown>;
    input: ResourcePayload;
    operation: 'create' | 'update';
  }) => Promise<void>;
}

function readCapsOf(config: ResourceConfig): readonly Capability[] {
  return config.readCaps ?? [config.writeCap];
}

/** `GET` (list) + `POST` (create) for `/api/admin/<resource>/index.ts`. */
export function collectionRoutes(config: ResourceConfig): { GET: APIRoute; POST: APIRoute } {
  const GET = defineAdminRoute({
    cap: readCapsOf(config)[0] as Capability,
    // The FULL read set goes to the kernel, not a widening check inside the handler:
    // the handler runs after the gate, so a widening there is unreachable for exactly
    // the callers it was meant to admit.
    anyCap: readCapsOf(config),
    access: config.readAccess ?? ['full', 'view', 'meta'],
    input: ListQuerySchema,
    handler: async ({ auth, sb, input, url }) => {
      const filters: Record<string, string> = {};
      if (input.status) filters['status'] = input.status;
      for (const column of config.filterableColumns ?? []) {
        const value = url.searchParams.get(column);
        if (value !== null) filters[column] = value;
      }

      const { rows, total } = await listRows(sb, config.table, auth, {
        columns: config.listColumns,
        orderBy: config.orderBy,
        filters,
        search:
          config.searchColumn && input.q
            ? { column: config.searchColumn, term: input.q }
            : undefined,
        limit: input.limit,
        offset: input.offset,
      });
      return { rows, total, limit: input.limit, offset: input.offset };
    },
  });

  const POST = defineAdminRoute({
    cap: config.writeCap,
    input: config.createSchema,
    handler: async ({ auth, sb, input, audit }) => {
      const payload = input as ResourcePayload;
      // Creating something already published is a publish. Checking only on transitions
      // would leave "POST with status: 'published'" as an unguarded back door around
      // the publish capability.
      assertStatusTransition(auth, config.statusOf?.(payload));

      const values = config.toRow(payload);
      if (config.statusOf?.(payload) === 'published') config.assertPublishable?.(values);

      const row = await insertRow<Record<string, unknown>>(
        sb,
        config.table,
        auth,
        values,
        config.columns,
      );
      audit({
        action: `${config.entity}.create`,
        entityType: config.entity,
        entityId: String(row['id']),
        detail: { status: values['status'] ?? null },
      });
      await config.afterWrite?.({ auth, sb, row, input: payload, operation: 'create' });
      return row;
    },
  });

  return { GET, POST };
}

/** `GET` + `PATCH` + `DELETE` for `/api/admin/<resource>/[id].ts`. */
export function itemRoutes(config: ResourceConfig): {
  GET: APIRoute;
  PATCH: APIRoute;
  DELETE: APIRoute;
} {
  /** A non-uuid `[id]` is 404, not 500 — the param comes straight from the URL. */
  const requireId = (params: Record<string, string | undefined>): string => {
    const id = params['id'];
    if (!id || !z.string().uuid().safeParse(id).success) throw new NotFoundError(config.entity);
    return id;
  };

  const GET = defineAdminRoute({
    cap: readCapsOf(config)[0] as Capability,
    anyCap: readCapsOf(config),
    access: config.readAccess ?? ['full', 'view', 'meta'],
    handler: async ({ auth, sb, params }) =>
      getRow(sb, config.table, auth, requireId(params), config.columns),
  });

  const PATCH = defineAdminRoute({
    cap: config.writeCap,
    input: config.updateSchema,
    handler: async ({ auth, sb, input, params, audit }) => {
      const id = requireId(params);
      const payload = input as ResourcePayload & { version: number };
      assertStatusTransition(auth, config.statusOf?.(payload));

      const values = config.toRow(payload);
      if (Object.keys(values).length === 0) {
        throw new ValidationError('no updatable fields supplied');
      }

      if (config.statusOf?.(payload) === 'published' && config.assertPublishable) {
        // Merge over the stored row: a partial PATCH that only flips `status` still has
        // to satisfy the publish preconditions, and those live in the columns it did
        // not send.
        const stored = await getRow<Record<string, unknown>>(
          sb,
          config.table,
          auth,
          id,
          config.columns,
        );
        config.assertPublishable({ ...stored, ...values });
      }

      const row = await updateRow<Record<string, unknown>>(
        sb,
        config.table,
        auth,
        id,
        payload.version,
        values,
        config.columns,
      );
      audit({
        action: `${config.entity}.update`,
        entityType: config.entity,
        entityId: id,
        // Field NAMES, never values — this table is read by anyone with `audit.view`
        // and some of these entities carry PII-adjacent copy.
        detail: { fields: Object.keys(values), version: payload.version },
      });
      await config.afterWrite?.({ auth, sb, row, input: payload, operation: 'update' });
      return row;
    },
  });

  const DELETE = defineAdminRoute({
    // NOT the write capability: deleting is `content.archiveDelete`, which in §5 is
    // Admin-only even for entities Content Creator may freely author.
    cap: 'content.archiveDelete',
    handler: async ({ auth, sb, params, audit }) => {
      const id = requireId(params);
      // BOTH capabilities: you may only delete a thing you were allowed to author.
      // content.archiveDelete alone would let an Admin-only role delete rows in a table
      // it has no write capability for, which is not what the matrix says.
      assertCap(auth, config.writeCap, ['full']);
      await deleteRow(sb, config.table, auth, id);
      audit({ action: `${config.entity}.delete`, entityType: config.entity, entityId: id });
      return { deleted: id };
    },
  });

  return { GET, PATCH, DELETE };
}

/** Bulk `sort_order` update — used by every drag-to-reorder list in the admin. */
export function reorderRoute(config: ResourceConfig): APIRoute {
  return defineAdminRoute({
    cap: config.writeCap,
    input: z.object({
      items: z
        .array(z.object({ id: z.string().uuid(), sortOrder: z.number().int() }))
        .min(1)
        .max(200),
    }),
    handler: async ({ auth, sb, input, audit }) => {
      // Sequential, tenant-scoped updates rather than one upsert: an upsert would need
      // to send every column (PostgREST upsert replaces the row) and would happily
      // INSERT a row whose id does not exist in this tenant — turning a reorder into a
      // cross-tenant write primitive.
      for (const item of input.items) {
        const { error } = await sb
          .from(config.table)
          .update({ sort_order: item.sortOrder })
          .eq('tenant_id', auth.tenantId)
          .eq('id', item.id);
        if (error) throw new Error(`reorder ${config.table}: ${error.message}`);
      }
      audit({
        action: `${config.entity}.reorder`,
        entityType: config.entity,
        detail: { count: input.items.length },
      });
      return { reordered: input.items.length };
    },
  });
}

export { json };
