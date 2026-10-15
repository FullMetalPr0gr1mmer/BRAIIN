import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// The release registry (app.release_entities, Admin v2 R1) as the migrations seed it,
// read from the SQL so the tests can hold it against ROLE_CAPS, the resource configs, the
// TypeScript registry (src/lib/release/registry.ts, R2) and packages/schemas/release.ts.
// Each migration keeps every registry row in one fixed shape for this.

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations');

const sqlOf = (file: string) =>
  readFileSync(join(MIGRATIONS, file), 'utf8').replace(/--[^\n]*/g, '');

/** 0038, which creates the registry (its CHECKs are parsed from here). */
export const RELEASE_LEDGER_SQL = sqlOf('0038_release_ledger.sql');

export interface RegistryRow {
  entityType: string;
  table: string;
  keyColumn: 'id' | 'tenant_id';
  area: string;
  authorRoles: string[];
  deleteRoles: string[];
  columns: string[];
  deferredColumns: string[];
  uniqueFlags: string[];
  exemptColumns: string[];
  applyOrder: number;
  hasStatus: boolean;
  publishFlag: string | null;
}

const list = (literal: string): string[] => (literal === '' ? [] : literal.split(','));

const ROW = new RegExp(
  [
    String.raw`\('([a-z_]+)'`, // entity_type
    String.raw`'([a-z_]+)'`, // table_name
    String.raw`'(id|tenant_id)'`, // key_column
    String.raw`'([a-z_]+)'`, // area
    ...Array.from({ length: 6 }, () => String.raw`'\{([a-z0-9_,]*)\}'`), // the six arrays
    String.raw`(\d+)`, // apply_order
    String.raw`(true|false)`, // has_status
    String.raw`(null|'[a-z_]+')\)`, // publish_flag
  ].join(String.raw`,\s*`),
  'g',
);

function toRow(m: RegExpMatchArray): RegistryRow {
  return {
    entityType: m[1]!,
    table: m[2]!,
    keyColumn: m[3] as 'id' | 'tenant_id',
    area: m[4]!,
    authorRoles: list(m[5]!),
    deleteRoles: list(m[6]!),
    columns: list(m[7]!),
    deferredColumns: list(m[8]!),
    uniqueFlags: list(m[9]!),
    exemptColumns: list(m[10]!),
    applyOrder: Number(m[11]),
    hasStatus: m[12] === 'true',
    publishFlag: m[13] === 'null' ? null : m[13]!.slice(1, -1),
  };
}

/** Every row of every registry insert in one migration's SQL, in order. */
function rowsOf(sql: string): RegistryRow[] {
  const inserts = sql.match(/insert into app\.release_entities[\s\S]*?on conflict/gi) ?? [];
  return inserts.flatMap((insert) => [...insert.matchAll(ROW)].map(toRow));
}

/** The migration files, in the order they apply. */
export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();
}

/**
 * The registry as the migrations leave it: every migration's `insert into
 * app.release_entities … on conflict` blocks in file order, a later row for an entity type
 * replacing the earlier one (U7, U14, E3, E5 and E8 add theirs with their tables). With
 * `sql`, the rows of that SQL alone.
 */
export function registryRows(sql?: string): RegistryRow[] {
  if (sql !== undefined) return rowsOf(sql);
  const byType = new Map<string, RegistryRow>();
  for (const file of migrationFiles()) {
    for (const row of rowsOf(sqlOf(file))) byType.set(row.entityType, row);
  }
  return [...byType.values()];
}

/** The quoted values of the `check (<column> in (...))` the migration declares. */
export function checkList(column: string, sql: string = RELEASE_LEDGER_SQL): string[][] {
  const re = new RegExp(String.raw`check \(${column} in \(([^)]*)\)\)`, 'g');
  return [...sql.matchAll(re)].map((m) => [...m[1]!.matchAll(/'([a-z_]+)'/g)].map((v) => v[1]!));
}
