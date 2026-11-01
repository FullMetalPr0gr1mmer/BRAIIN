import type { APIRoute } from 'astro';
import type { SupabaseClient } from '@supabase/supabase-js';
import { writeSystemLog } from '@/lib/data/systemLog';
import { z } from 'zod';
import type { Access, Capability } from '@/lib/authz/matrix';
import type { AuthContext } from '@/lib/auth/types';
import { AuthorizationError } from '@/lib/authz/errors';
import { defineAdminRoute } from './route';
import { constraintOf, type ConstraintFields } from './crud';
import { OptimisticLockError, ValidationError } from './errors';
import type { ResourcePayload } from './resource';
import {
  singletonEntry,
  stagedSingletonRead,
  stagedSingletonUpdate,
} from '@/lib/release/stagedSingleton';
import { refuseStagedBody } from '@/lib/release/releasesOff';

/**
 * 42501 from a singleton write means the DATABASE refused it after assertCap() allowed
 * it: a guard trigger narrower than the row (site_profile.accepting_applications is
 * Admin-only while the rest of the row is Admin + Developer — migration 0019), or RLS.
 * That is an authorization outcome and must reach the client as 403, not as the generic
 * 500 every other unexpected error becomes.
 */
export function rethrowWriteError(
  table: string,
  cap: Capability,
  verb: string,
  error: { code?: string; message: string; details?: string | null },
  foreignKeys: ConstraintFields = {},
  checks: ConstraintFields = {},
): never {
  if (error.code === '42501')
    throw new AuthorizationError(cap, `database refused the ${table} write`);
  // 23503 on a key the config names = a reference the editor chose that does not exist for
  // this tenant (seo_defaults' share image, 0073: a composite key to the tenant's own media).
  // Bad input, so 422 on that field, not a 500 in system_logs. Any other key stays a 500.
  if (error.code === '23503') {
    const name = constraintOf(error);
    const known = name ? foreignKeys[name] : undefined;
    if (known) throw new ValidationError(known.message, known.field);
  }
  // 23514 = a CHECK constraint the schema could not see, because a PATCH names only the
  // fields it changes and the check spans stored ones (site_profile: a WhatsApp display
  // form needs the E.164 number it displays). Bad input, so 422 — not a 500. A constraint
  // the config names (Admin v2 U9: an icon that is not a square upload) is a 422 on its field.
  if (error.code === '23514') {
    const name = constraintOf(error);
    const known = name ? checks[name] : undefined;
    if (known) throw new ValidationError(known.message, known.field);
    throw new ValidationError(`the change conflicts with a stored value on '${table}'`);
  }
  throw new Error(`${verb} ${table}: ${error.message}`);
}

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
  /**
   * Payload key → the columns `toRow` emits for it (see ResourceConfig.fields). Required
   * for a singleton in the release registry (site_profile, seo_defaults); the others omit it.
   */
  fields?: Readonly<Record<string, readonly string[]>>;
  /**
   * Columns that are never staged by a release: they stay immediate, written by their own
   * endpoint (site_profile.accepting_applications, Admin v2 P-3; app.release_entities'
   * exempt_columns). The legacy PATCH still writes them while releases are off.
   */
  immediateColumns?: readonly string[];
  /**
   * The row's foreign keys → the field and message a refused reference (23503) reports, so a
   * save naming a missing record is a 422 on that field (seo_defaults' share image, 0073).
   */
  foreignKeys?: ConstraintFields;
  /**
   * The row's CHECKs (and a guard trigger's refusals named as one) → the field and message a
   * refused value (23514) reports (Admin v2 U9: site_profile's icons and phone pair).
   */
  constraintFields?: ConstraintFields;
  /**
   * Runs after a successful live write, before the audit row is queued (Admin v2 U9b: a new
   * contact snapshot for the maintenance page). Best effort: it never fails the save, and
   * what it returns joins the audit detail.
   */
  afterWrite?: (ctx: {
    auth: AuthContext;
    sb: SupabaseClient;
    row: Record<string, unknown>;
  }) => Promise<Record<string, unknown> | void>;
  /**
   * With releases on only: what a staged read or save adds from the LIVE row, beside the row
   * with the pending change laid over it (the forms config's live consent lines, Admin v2 E8,
   * so its editor can say which version a publish will post). Never written.
   */
  stagedExtras?: (live: Record<string, unknown> | null) => Record<string, unknown>;
  /** Returned by GET when no row exists yet. */
  defaults: Record<string, unknown>;
  /**
   * Stored columns `guardWrite` needs, read alongside `version` before the write.
   * Comma-separated, like `columns`.
   */
  guardColumns?: string;
  /**
   * A Worker-side check for a rule narrower than `writeCap` — the SECOND server layer
   * beside a database guard (CLAUDE.md Pillar 1: both must pass). Runs after the row is
   * read and before any write; throw AuthorizationError to refuse. `existing` is null on
   * the first save (an INSERT), where the table defaults are the "before" state.
   */
  guardWrite?: (
    auth: AuthContext,
    existing: Record<string, unknown> | null,
    values: Record<string, unknown>,
  ) => void;
}

/** A config's afterWrite, which never fails the save: a throw is logged and reported. */
async function runAfterWrite(
  config: SingletonConfig,
  auth: AuthContext,
  sb: SupabaseClient,
  row: unknown,
): Promise<Record<string, unknown>> {
  try {
    return (
      (await config.afterWrite?.({
        auth,
        sb,
        row: (row ?? {}) as Record<string, unknown>,
      })) ?? {}
    );
  } catch (err) {
    await writeSystemLog({
      level: 'warn',
      source: `admin:${config.writeCap}`,
      message: `${config.table}: the follow-up after a save failed`,
      detail: { reason: err instanceof Error ? err.message.slice(0, 200) : 'unknown' },
    });
    return { afterWrite: 'failed' };
  }
}

export function singletonRoutes(config: SingletonConfig): { GET: APIRoute; PATCH: APIRoute } {
  const readAccess = config.readAccess ?? ['full', 'view', 'meta'];

  const GET = defineAdminRoute({
    cap: config.readCaps[0] as Capability,
    anyCap: config.readCaps,
    access: readAccess,
    handler: async (ctx) => {
      // Releases on (Admin v2 R3b): live with the tenant's pending change laid over it.
      const entry = singletonEntry(config);
      if (entry && (await ctx.releasesEnabled())) return stagedSingletonRead(config, entry, ctx);
      const { auth, sb } = ctx;
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
    // The body is parsed in the handler, as the resource kernel's PATCH does (Admin v2 R3): a
    // staged save also reads `draftId`/`draftVersion`, which the schema would strip.
    input: z.unknown(),
    handler: async (ctx) => {
      const entry = singletonEntry(config);
      if (entry && (await ctx.releasesEnabled())) {
        return stagedSingletonUpdate(config, entry, ctx, ctx.input);
      }
      // Releases off: a save made in release mode is refused, never written live (R12).
      if (entry) refuseStagedBody(ctx.input, config.entity);
      const { auth, sb, audit } = ctx;
      const payload = config.schema.parse(ctx.input) as ResourcePayload & { version: number };
      const values = config.toRow(payload);

      const { data: existing, error: readError } = await sb
        .from(config.table)
        .select(config.guardColumns ? `version,${config.guardColumns}` : 'version')
        .eq('tenant_id', auth.tenantId)
        .maybeSingle<{ version: number } & Record<string, unknown>>();
      if (readError) throw new Error(`read ${config.table}: ${readError.message}`);
      config.guardWrite?.(auth, existing ?? null, values);

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
          rethrowWriteError(
            config.table,
            config.writeCap,
            'create',
            error,
            config.foreignKeys,
            config.constraintFields,
          );
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
        if (error) {
          rethrowWriteError(
            config.table,
            config.writeCap,
            'update',
            error,
            config.foreignKeys,
            config.constraintFields,
          );
        }
        if (!data) throw new OptimisticLockError(config.table);
        row = data;
      }

      const effect = config.afterWrite ? await runAfterWrite(config, auth, sb, row) : {};
      audit({
        action: `${config.entity}.update`,
        entityType: config.entity,
        entityId: auth.tenantId,
        detail: { fields: Object.keys(values), ...effect },
      });
      return row;
    },
  });

  return { GET, PATCH };
}
