import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// The release registry (app.release_entities, Admin v2 R1) as the migrations leave it,
// read from the SQL so the tests can hold it against ROLE_CAPS, the resource configs, the
// TypeScript registry (src/lib/release/registry.ts, R2) and packages/schemas/release.ts.
//
// The parser is strict on purpose: a registry change it cannot read must FAIL the tests,
// never be skipped. So every `insert into app.release_entities` must name the columns in
// the one order below, every value tuple must parse (a row in another shape, a NULL array,
// ARRAY[...] or a cast is refused), its `on conflict (entity_type)` must be `do nothing`
// (an existing row wins) or `do update` (the new row wins), and any other write to the
// table (update, delete, truncate, merge, an alter other than its RLS switches) throws:
// teach this file to read it, in the same change.

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations');

const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, '');

const sqlOf = (file: string) => stripComments(readFileSync(join(MIGRATIONS, file), 'utf8'));

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

/** The column list every registry insert must name, in this order. */
const INSERT_COLUMNS = [
  'entity_type',
  'table_name',
  'key_column',
  'area',
  'author_roles',
  'delete_roles',
  'columns',
  'deferred_columns',
  'unique_flags',
  'exempt_columns',
  'apply_order',
  'has_status',
  'publish_flag',
];

const list = (literal: string): string[] => (literal === '' ? [] : literal.split(','));

const ROW = new RegExp(
  '^' +
    [
      String.raw`\('([a-z_]+)'`, // entity_type
      String.raw`'([a-z_]+)'`, // table_name
      String.raw`'(id|tenant_id)'`, // key_column
      String.raw`'([a-z_]+)'`, // area
      ...Array.from({ length: 6 }, () => String.raw`'\{([a-z0-9_,]*)\}'`), // the six arrays
      String.raw`(\d+)`, // apply_order
      String.raw`(true|false)`, // has_status
      String.raw`(null|'[a-z_]+')\)`, // publish_flag
    ].join(String.raw`,\s*`) +
    '$',
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

/** The statement starting at `from`, up to its `;` (outside quotes). */
function statementAt(sql: string, from: number): string {
  let quoted = false;
  for (let i = from; i < sql.length; i += 1) {
    const ch = sql[i];
    if (ch === "'") quoted = !quoted;
    else if (ch === ';' && !quoted) return sql.slice(from, i);
  }
  return sql.slice(from);
}

/** The top-level parenthesised groups of a VALUES list, each with its parentheses. */
function tuples(values: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = -1;
  for (let i = 0; i < values.length; i += 1) {
    const ch = values[i];
    if (ch === "'") quoted = !quoted;
    if (quoted) continue;
    if (ch === '(') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0) out.push(values.slice(start, i + 1));
    }
  }
  return out;
}

export interface RegistryInsert {
  rows: RegistryRow[];
  /** `do nothing`: a row already there wins; `do update`: this row replaces it. */
  onConflict: 'nothing' | 'update';
}

/** Every registry write in one migration's SQL, in order; throws on one it cannot read. */
export function registryInserts(sql: string, file = 'inline SQL'): RegistryInsert[] {
  const clean = stripComments(sql);
  const unsupported =
    /\b(update\s+(only\s+)?app\.release_entities\b|delete\s+from\s+(only\s+)?app\.release_entities\b|truncate\s+(table\s+)?(only\s+)?app\.release_entities\b|merge\s+into\s+app\.release_entities\b)/i.exec(
      clean,
    );
  if (unsupported) {
    throw new Error(
      `${file}: "${unsupported[0]}" changes the registry in a way this fixture does not read`,
    );
  }
  for (const m of clean.matchAll(
    /alter\s+table\s+(if\s+exists\s+)?(only\s+)?app\.release_entities\b/gi,
  )) {
    const statement = statementAt(clean, m.index!);
    if (
      !/^alter\s+table\s+app\.release_entities\s+(enable|force)\s+row\s+level\s+security\s*$/i.test(
        statement.trim(),
      )
    ) {
      throw new Error(
        `${file}: "${statement.trim()}" alters the registry; teach this fixture to read it`,
      );
    }
  }

  const out: RegistryInsert[] = [];
  for (const m of clean.matchAll(/insert\s+into\s+app\.release_entities\b/gi)) {
    const statement = statementAt(clean, m.index!);
    const shape =
      /^insert\s+into\s+app\.release_entities\s*\(([^)]*)\)\s*values\s*([\s\S]*?)\s*on\s+conflict\s*\(\s*entity_type\s*\)\s*do\s+(nothing|update\b[\s\S]*)$/i.exec(
        statement.trim(),
      );
    if (!shape) {
      throw new Error(
        `${file}: a registry insert this fixture cannot read (it needs a column list, VALUES and on conflict (entity_type) do nothing | do update)`,
      );
    }
    const columns = shape[1]!.split(',').map((c) => c.trim());
    if (columns.join(',') !== INSERT_COLUMNS.join(',')) {
      throw new Error(
        `${file}: a registry insert names (${columns.join(', ')}), not the fixed order`,
      );
    }
    const groups = tuples(shape[2]!);
    const rows = groups.map((group) => {
      const parsed = ROW.exec(group.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')'));
      if (!parsed) throw new Error(`${file}: a registry row this fixture cannot read: ${group}`);
      return toRow(parsed);
    });
    out.push({ rows, onConflict: /^nothing$/i.test(shape[3]!) ? 'nothing' : 'update' });
  }
  return out;
}

/** The migration files, in the order they apply. */
export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();
}

/**
 * The registry after a list of migrations, in order: `do nothing` keeps a row already
 * there (the first one wins), `do update` replaces it (the last one wins).
 */
export function foldRegistry(migrations: readonly { file: string; sql: string }[]): RegistryRow[] {
  const byType = new Map<string, RegistryRow>();
  for (const { file, sql } of migrations) {
    for (const insert of registryInserts(sql, file)) {
      for (const row of insert.rows) {
        if (insert.onConflict === 'nothing' && byType.has(row.entityType)) continue;
        byType.set(row.entityType, row);
      }
    }
  }
  return [...byType.values()];
}

/**
 * The registry as the migrations leave it (U7, U14, E3, E5 and E8 add rows with their
 * tables). With `sql`, the registry that SQL alone would leave.
 */
export function registryRows(sql?: string): RegistryRow[] {
  if (sql !== undefined) return foldRegistry([{ file: 'inline SQL', sql }]);
  return foldRegistry(migrationFiles().map((file) => ({ file, sql: sqlOf(file) })));
}

/** The quoted values of the `check (<column> in (...))` the migration declares. */
export function checkList(column: string, sql: string = RELEASE_LEDGER_SQL): string[][] {
  const re = new RegExp(String.raw`check \(${column} in \(([^)]*)\)\)`, 'g');
  return [...sql.matchAll(re)].map((m) => [...m[1]!.matchAll(/'([a-z_]+)'/g)].map((v) => v[1]!));
}
