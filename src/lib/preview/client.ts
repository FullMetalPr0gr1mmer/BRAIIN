import type { SupabaseClient } from '@supabase/supabase-js';
import { matchesQuery } from '@/lib/release/overlay';
import { isPreviewTable, resolveEmbed, type EmbedRelation, type PreviewTable } from './relations';
import { noteOnce, type PreviewReport } from './report';
import { parseSelect, PreviewUnsupportedError, type SelectItem } from './select';
import { ANON_COLUMNS, type Mirror } from './visibility';

// The preview's stand-in for the anon Supabase client (Admin v2 R8; docs/admin-v2/README.md
// "Preview"): an in-memory emulator of exactly the PostgREST surface the public loaders use,
// answered from the preview dataset (live rows of the person's tenant with the pending
// changes laid over them) through the anon-RLS mirror, so a loader reads in preview what a
// visitor will read once the changes are live.
//
// The surface (verification.md claim 13, re-checked against the 15 loaders):
//   from(table).select(list) with embeds up to three tables deep, then in any order
//   eq(column, value), in(column, values), contains(arrayColumn, values),
//   order(column, {ascending, nullsFirst}), limit(n), maybeSingle(), and await.
// Anything else is REFUSED: the attempt is recorded in the report first (a loader's own
// try/catch would otherwise turn the gap into a silently empty section), then it throws,
// in every build. `rpc()` answers `PV001` "not previewable" and is recorded as not
// previewed (search reads only live data, edge case 25). The verdict (report.ts) marks a
// render with any refusal untrusted.
//
// PostgREST semantics kept: eq and in compare as text (R2's matchesQuery), and a NULL
// matches nothing; filters on an embedded column (`service.slug`) are refused; order sorts
// numbers, booleans and ISO timestamps natively and other text by code unit (the database
// uses its collation; no loader orders by text), NULLs last ascending and first
// descending unless `nullsFirst` says otherwise, several keys, stable (ties keep the
// dataset's key order); limit applies after ordering; maybeSingle answers null for no row
// and PGRST116 for more than one. A column a row of the table does not have answers 42703,
// and a column outside anon's grant on a column-granted table 42501, as for a visitor. An
// embedded row passes the mirror as a top-level row does (a hidden client embeds as null,
// an unpublished project's link rows leave the array); a one-to-many array is in dataset
// order (PostgREST gives none; the loaders sort in JavaScript).
//
// The client is built for one request's dataset, which every builder uses directly: a
// builder's `then()` reads nothing from the AsyncLocalStorage scope (verification claim 11).

type Row = Readonly<Record<string, unknown>>;

/** A PostgREST-shaped error, as supabase-js hands it to a loader. */
export interface PreviewError {
  code: string;
  message: string;
  details: string | null;
  hint: string | null;
}

/** What the emulator needs from the dataset. */
export interface OverlayData {
  /**
   * Loads, once per request, each table and every table its anon rule reads, with the
   * pending changes laid over them. Resolves to the first read's error, or null.
   */
  ensure(tables: readonly PreviewTable[]): Promise<PreviewError | null>;
  /** The overlaid rows of a loaded table, in key order. */
  rows(table: PreviewTable): readonly Row[];
  /** The row of a loaded table whose `id` is `id`. */
  byId(table: PreviewTable, id: unknown): Row | undefined;
  /** The rows of a loaded table whose `column` equals `id`, in key order. */
  childrenOf(table: PreviewTable, column: string, id: unknown): readonly Row[];
  /** The columns the table's rows carry, or null when it has no live row to tell. */
  columns(table: PreviewTable): ReadonlySet<string> | null;
  /** The anon-RLS mirror over the same rows. */
  readonly mirror: Mirror;
}

type Primitive = string | number | boolean;

type Filter =
  | { op: 'eq'; column: string; value: Primitive }
  | { op: 'in'; column: string; values: readonly Primitive[] }
  | { op: 'contains'; column: string; values: readonly Primitive[] };

interface Order {
  column: string;
  ascending: boolean;
  nullsFirst: boolean;
}

type Resolved =
  | { kind: 'column'; name: string }
  | { kind: 'embed'; alias: string; relation: EmbedRelation; items: readonly Resolved[] };

interface Result {
  data: unknown;
  error: PreviewError | null;
  count: null;
  status: number;
  statusText: string;
}

const BUILDER_METHODS = new Set([
  'select',
  'eq',
  'in',
  'contains',
  'order',
  'limit',
  'maybeSingle',
  'then',
]);
const COLUMN = /^[a-z_][a-z0-9_]*$/;
const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/;

const pgError = (code: string, message: string, details: string | null = null): PreviewError => ({
  code,
  message,
  details,
  hint: null,
});

const failed = (error: PreviewError, status = 400): Result => ({
  data: null,
  error,
  count: null,
  status,
  statusText: 'Bad Request',
});

const isPrimitive = (v: unknown): v is Primitive =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/** Two non-null values, compared as PostgreSQL would for the column types loaders sort. */
export function compareValues(x: unknown, y: unknown): number {
  if (typeof x === 'number' && typeof y === 'number') return x - y;
  if (typeof x === 'boolean' && typeof y === 'boolean') return Number(x) - Number(y);
  if (
    typeof x === 'string' &&
    typeof y === 'string' &&
    ISO_INSTANT.test(x) &&
    ISO_INSTANT.test(y)
  ) {
    const a = Date.parse(x.replace(' ', 'T'));
    const b = Date.parse(y.replace(' ', 'T'));
    if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return a - b;
  }
  const a = String(x);
  const b = String(y);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A stable multi-key comparator with PostgREST's NULL placement. */
export function orderRows(rows: readonly Row[], orders: readonly Order[]): Row[] {
  const isNull = (v: unknown) => v === null || v === undefined;
  return [...rows].sort((a, b) => {
    for (const o of orders) {
      const x = a[o.column];
      const y = b[o.column];
      if (isNull(x) && isNull(y)) continue;
      if (isNull(x)) return o.nullsFirst ? -1 : 1;
      if (isNull(y)) return o.nullsFirst ? 1 : -1;
      const c = compareValues(x, y);
      if (c !== 0) return o.ascending ? c : -c;
    }
    return 0;
  });
}

function matches(row: Row, filter: Filter, refuse: (what: string) => never): boolean {
  switch (filter.op) {
    case 'eq':
      return matchesQuery(row, { filters: { [filter.column]: String(filter.value) } });
    case 'in':
      return filter.values.some((v) =>
        matchesQuery(row, { filters: { [filter.column]: String(v) } }),
      );
    case 'contains': {
      const value = row[filter.column];
      if (value === null || value === undefined) return false;
      if (!Array.isArray(value)) return refuse(`contains on a non-array column`);
      return filter.values.every((v) => value.some((item) => String(item) === String(v)));
    }
  }
}

/**
 * The client a preview's loaders get from `contentClient()`. Cast to SupabaseClient so the
 * loaders keep their supabase-js types; nothing else may rely on the cast.
 */
export function createOverlayClient(data: OverlayData, report: PreviewReport): SupabaseClient {
  const refuse = (what: string): never => {
    noteOnce(report.unsupported, what);
    throw new PreviewUnsupportedError(what);
  };

  function resolve(table: PreviewTable, items: readonly SelectItem[]): Resolved[] {
    return items.map((item) => {
      if (item.kind === 'column') return item;
      const relation = resolveEmbed(table, item.target);
      if (!relation) return refuse(`${table}: embed ${item.target}`);
      return {
        kind: 'embed' as const,
        alias: item.alias,
        relation,
        items: resolve(relation.target, item.items),
      };
    });
  }

  /** Every table a resolved select reads. */
  function tablesOf(table: PreviewTable, items: readonly Resolved[], out: Set<PreviewTable>) {
    out.add(table);
    for (const item of items) {
      if (item.kind === 'embed') tablesOf(item.relation.target, item.items, out);
    }
    return out;
  }

  /** 42501 / 42703 for a column anon could not read, or the table does not have. */
  function columnError(table: PreviewTable, column: string): PreviewError | null {
    const granted = ANON_COLUMNS[table];
    if (granted && !granted.includes(column)) {
      return pgError('42501', `permission denied for table ${table}`);
    }
    const known = data.columns(table);
    if (known && !known.has(column)) {
      return pgError('42703', `column ${table}.${column} does not exist`);
    }
    return null;
  }

  function selectErrors(table: PreviewTable, items: readonly Resolved[]): PreviewError | null {
    for (const item of items) {
      const error =
        item.kind === 'column'
          ? columnError(table, item.name)
          : item.relation.cardinality === 'one'
            ? (columnError(table, item.relation.column) ??
              selectErrors(item.relation.target, item.items))
            : (columnError(item.relation.target, item.relation.childColumn) ??
              selectErrors(item.relation.target, item.items));
      if (error) return error;
    }
    return null;
  }

  function project(table: PreviewTable, row: Row, items: readonly Resolved[]) {
    const out: Record<string, unknown> = {};
    for (const item of items) {
      if (item.kind === 'column') {
        out[item.name] = row[item.name] ?? null;
        continue;
      }
      const { relation } = item;
      if (relation.cardinality === 'one') {
        const target = data.byId(relation.target, row[relation.column]);
        out[item.alias] =
          target && data.mirror.isVisible(relation.target, target)
            ? project(relation.target, target, item.items)
            : null;
      } else {
        out[item.alias] = data
          .childrenOf(relation.target, relation.childColumn, row['id'])
          .filter((child) => data.mirror.isVisible(relation.target, child))
          .map((child) => project(relation.target, child, item.items));
      }
    }
    return out;
  }

  function builder(table: PreviewTable) {
    let select: Resolved[] | null = null;
    const filters: Filter[] = [];
    const orders: Order[] = [];
    let limit: number | null = null;
    let single = false;

    const column = (op: string, name: unknown): string => {
      if (typeof name !== 'string' || !COLUMN.test(name)) {
        return refuse(`${table}.${op} on an embedded or unnamed column`);
      }
      return name;
    };
    const selected = (op: string): void => {
      if (select === null) refuse(`${table}.${op} before select`);
    };

    async function run(): Promise<Result> {
      if (select === null) return refuse(`${table}: no select`);
      const tables = tablesOf(table, select, new Set());
      const failure = await data.ensure([...tables]);
      if (failure) return failed(failure);
      const columnFailure =
        selectErrors(table, select) ??
        [...filters.map((f) => f.column), ...orders.map((o) => o.column)]
          .map((name) => columnError(table, name))
          .find((e) => e !== null) ??
        null;
      if (columnFailure) return failed(columnFailure);

      const kept = data
        .rows(table)
        .filter((row) => data.mirror.isVisible(table, row))
        .filter((row) => filters.every((f) => matches(row, f, refuse)));
      const ordered = orders.length > 0 ? orderRows(kept, orders) : kept;
      const limited = limit === null ? ordered : ordered.slice(0, limit);
      const rows = limited.map((row) => project(table, row, select!));

      if (single && rows.length > 1) {
        return failed(
          pgError(
            'PGRST116',
            'JSON object requested, multiple (or no) rows returned',
            `Results contain ${rows.length} rows, application/vnd.pgrst.object+json requires 1 row`,
          ),
          406,
        );
      }
      report.reads += 1;
      report.tables[table] = (report.tables[table] ?? 0) + 1;
      return {
        data: single ? (rows[0] ?? null) : rows,
        error: null,
        count: null,
        status: 200,
        statusText: 'OK',
      };
    }

    const methods: Record<string, (...args: unknown[]) => unknown> = {
      select(list?: unknown, options?: unknown) {
        if (select !== null) refuse(`${table}.select twice`);
        if (options !== undefined) refuse(`${table}.select options`);
        if (typeof list !== 'string') return refuse(`${table}.select *`);
        let items: readonly SelectItem[];
        try {
          items = parseSelect(list);
        } catch (err) {
          if (err instanceof PreviewUnsupportedError) return refuse(`${table} ${err.what}`);
          throw err;
        }
        select = resolve(table, items);
        return proxy;
      },
      eq(name?: unknown, value?: unknown) {
        selected('eq');
        const col = column('eq', name);
        if (!isPrimitive(value)) refuse(`${table}.eq with a non-scalar value`);
        filters.push({ op: 'eq', column: col, value: value as Primitive });
        return proxy;
      },
      in(name?: unknown, values?: unknown) {
        selected('in');
        const col = column('in', name);
        if (!Array.isArray(values) || !values.every(isPrimitive)) {
          refuse(`${table}.in with a non-list`);
        }
        filters.push({ op: 'in', column: col, values: values as Primitive[] });
        return proxy;
      },
      contains(name?: unknown, values?: unknown) {
        selected('contains');
        const col = column('contains', name);
        if (!Array.isArray(values) || !values.every(isPrimitive)) {
          refuse(`${table}.contains with a non-array`);
        }
        filters.push({ op: 'contains', column: col, values: values as Primitive[] });
        return proxy;
      },
      order(name?: unknown, options?: unknown) {
        selected('order');
        const col = column('order', name);
        const opts = (options ?? {}) as Record<string, unknown>;
        if (
          typeof opts !== 'object' ||
          Object.keys(opts).some((k) => k !== 'ascending' && k !== 'nullsFirst') ||
          (opts['ascending'] !== undefined && typeof opts['ascending'] !== 'boolean') ||
          (opts['nullsFirst'] !== undefined && typeof opts['nullsFirst'] !== 'boolean')
        ) {
          refuse(`${table}.order options`);
        }
        const ascending = (opts['ascending'] as boolean | undefined) ?? true;
        const nullsFirst = (opts['nullsFirst'] as boolean | undefined) ?? !ascending;
        orders.push({ column: col, ascending, nullsFirst });
        return proxy;
      },
      limit(n?: unknown, options?: unknown) {
        selected('limit');
        if (options !== undefined) refuse(`${table}.limit options`);
        if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) refuse(`${table}.limit value`);
        limit = n as number;
        return proxy;
      },
      maybeSingle() {
        selected('maybeSingle');
        single = true;
        return proxy;
      },
      then(onFulfilled?: unknown, onRejected?: unknown) {
        return run().then(
          onFulfilled as ((value: Result) => unknown) | undefined,
          onRejected as ((reason: unknown) => unknown) | undefined,
        );
      },
    };

    const proxy: object = new Proxy(methods, {
      get(target, prop) {
        if (typeof prop === 'symbol') return undefined;
        if (BUILDER_METHODS.has(prop)) return target[prop];
        return refuse(`${table}.${prop}`);
      },
      set() {
        return refuse(`${table}: assignment`);
      },
    });
    return proxy;
  }

  const client = new Proxy(
    {},
    {
      get(_target, prop) {
        // Not a thenable, and inspectable (a test's pretty-printer reads symbols).
        if (typeof prop === 'symbol' || prop === 'then') return undefined;
        if (prop === 'from') {
          return (table: unknown) => {
            if (typeof table !== 'string' || !isPreviewTable(table)) {
              return refuse(`from ${String(table)}`);
            }
            return builder(table);
          };
        }
        if (prop === 'rpc') {
          return (name: unknown) => {
            noteOnce(report.notPreviewed, `rpc:${String(name)}`);
            return Promise.resolve(failed(pgError('PV001', 'not previewable')));
          };
        }
        return refuse(`client.${prop}`);
      },
    },
  );
  return client as unknown as SupabaseClient;
}
