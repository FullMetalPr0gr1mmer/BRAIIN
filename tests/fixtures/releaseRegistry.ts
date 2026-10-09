import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The release registry as migration 0038 seeds it (app.release_entities, Admin v2 R1),
// read from the SQL so the tests can hold it against ROLE_CAPS, the resource configs and
// packages/schemas/release.ts. The migration keeps each row in one fixed shape for this.

export const RELEASE_LEDGER_SQL = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '0038_release_ledger.sql'),
  'utf8',
).replace(/--[^\n]*/g, '');

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

/** Every row of the registry insert, in migration order. */
export function registryRows(sql: string = RELEASE_LEDGER_SQL): RegistryRow[] {
  const insert = /insert into app\.release_entities[\s\S]*?on conflict/i.exec(sql)?.[0] ?? '';
  return [...insert.matchAll(ROW)].map((m) => ({
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
  }));
}

/** The quoted values of the `check (<column> in (...))` the migration declares. */
export function checkList(column: string, sql: string = RELEASE_LEDGER_SQL): string[][] {
  const re = new RegExp(String.raw`check \(${column} in \(([^)]*)\)\)`, 'g');
  return [...sql.matchAll(re)].map((m) => [...m[1]!.matchAll(/'([a-z_]+)'/g)].map((v) => v[1]!));
}
