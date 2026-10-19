import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '@/lib/auth/types';

// The database as a domain rule should see it (Admin v2 R6; docs/admin-v2/releases.md §3,
// "assertWritable/assertPublishable receive ctx.db: OverlayDb"). The rules that read other rows
// (a link names a row of this site; a redirect's chain and the live routes it must not shadow)
// ask through this seam, so the same rule judges:
//   • a save while releases are off: `liveDb`, which sends exactly the queries the rules sent
//     before R6 (tests/lib/overlayDb.spec.ts pins them, and the call-for-call kernel specs stay
//     unchanged);
//   • a staged save (R3): `pendingDb`, live with every pending change of the tenant laid over
//     it, so a link to a pending create, or a redirect over a slug a pending change renames, is
//     not refused before anyone has published anything;
//   • a publish and its dry run (R6): `layeredDb` over the changes SELECTED, the state the
//     release leaves behind, so a release is judged on what it will publish and nothing else.
// Every read is tenant-scoped (the caller's tenant, never the request's) and runs under the
// caller's RLS client. No value read here leaves the Worker.

type Row = Record<string, unknown>;
type Db = SupabaseClient;

/** A read of several rows: equality and `in` filters, an order and a limit. */
export interface DbListQuery {
  /** A PostgREST select list of plain columns (no embeds). */
  columns: string;
  eq?: Readonly<Record<string, string | number | boolean>>;
  in?: Readonly<Record<string, readonly string[]>>;
  order?: { column: string; ascending?: boolean };
  limit?: number;
}

export interface OverlayDb {
  /** Does a row with this id exist in the caller's tenant (and match `where`)? */
  exists(
    table: string,
    id: string,
    where?: Readonly<Record<string, string | number | boolean>>,
  ): Promise<boolean>;
  /** The rows matching the query, at most `limit`. */
  list(table: string, query: DbListQuery): Promise<Row[]>;
  /** The first row matching the query, or null (a `.limit(1).maybeSingle()`). */
  first(table: string, query: DbListQuery): Promise<Row | null>;
}

/** One change laid over live: a new row (whole), an edit (its columns), or a removal. */
export type LayerChange =
  { op: 'create'; row: Row } | { op: 'update'; patch: Row } | { op: 'delete' };

/** The changes to one table, by key. */
export type TableLayer = ReadonlyMap<string, LayerChange>;

// ---- live -----------------------------------------------------------------------------------

/**
 * The live database, as the rules read it before R6. The query shapes are the rules' own:
 * `exists` is `assertLinkInTenant`'s, `first` is `liveRouteRefusal`'s, `list` is the redirect
 * chain read's.
 */
export function liveDb(sb: Db, auth: Pick<AuthContext, 'tenantId'>): OverlayDb {
  const build = (table: string, query: DbListQuery) => {
    let q = sb.from(table).select(query.columns).eq('tenant_id', auth.tenantId);
    for (const [column, value] of Object.entries(query.eq ?? {})) q = q.eq(column, value);
    for (const [column, values] of Object.entries(query.in ?? {})) q = q.in(column, [...values]);
    if (query.order) q = q.order(query.order.column, { ascending: query.order.ascending ?? true });
    return q;
  };
  return {
    async exists(table, id, where = {}) {
      let q = sb.from(table).select('id').eq('tenant_id', auth.tenantId).eq('id', id);
      for (const [column, value] of Object.entries(where)) q = q.eq(column, value);
      const { data, error } = await q.maybeSingle();
      if (error) throw new Error(`check ${table}: ${error.message}`);
      return Boolean(data);
    },
    async list(table, query) {
      let q = build(table, query);
      if (query.limit !== undefined) q = q.limit(query.limit);
      const { data, error } = await q;
      if (error) throw new Error(`read ${table}: ${error.message}`);
      return (data ?? []) as unknown as Row[];
    },
    async first(table, query) {
      const { data, error } = await build(table, query).limit(1).maybeSingle();
      if (error) throw new Error(`check ${table}: ${error.message}`);
      return (data as Row | null) ?? null;
    },
  };
}

// ---- layered --------------------------------------------------------------------------------

/** The plain column names of a select list (`*` is every column). */
function namesOf(columns: string): string[] | null {
  if (columns.trim() === '*') return null;
  return columns
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
}

/** A row matches a query's filters the way PostgREST would compare them (as text). */
export function matchesFilters(row: Readonly<Row>, query: Pick<DbListQuery, 'eq' | 'in'>): boolean {
  for (const [column, value] of Object.entries(query.eq ?? {})) {
    const v = row[column];
    if (v === null || v === undefined || String(v) !== String(value)) return false;
  }
  for (const [column, values] of Object.entries(query.in ?? {})) {
    const v = row[column];
    if (v === null || v === undefined || !values.map(String).includes(String(v))) return false;
  }
  return true;
}

function compareBy(column: string, ascending: boolean) {
  return (a: Row, b: Row): number => {
    const x = a[column];
    const y = b[column];
    const xNull = x === null || x === undefined;
    const yNull = y === null || y === undefined;
    if (xNull || yNull) return xNull && yNull ? 0 : xNull === ascending ? 1 : -1;
    const order = String(x) < String(y) ? -1 : String(x) > String(y) ? 1 : 0;
    return ascending ? order : -order;
  };
}

const project = (row: Row, names: string[] | null): Row => {
  if (!names) return { ...row };
  const out: Row = {};
  for (const name of names) if (name in row) out[name] = row[name];
  return out;
};

export interface LayeredOptions {
  /** The column a layer keys its rows by, per table (`id` unless named). */
  keyOf?: (table: string) => string;
  /**
   * `exists` asks live first and consults the layer only when live has no such row: a link to
   * a pending create passes, and a link to a row with a pending removal is not refused yet (the
   * release that carries the removal is where that is judged). For a staged save, so a save
   * that links to a live row costs no draft read.
   */
  existsLiveFirst?: boolean;
}

/**
 * Live with a layer of changes over it: a removed row is gone, an edited row reads its new
 * values (and leaves or joins a filtered read by them), a new row is there. `layerOf` answers
 * the table's changes (null: none, so the read is live's alone); it may load them lazily.
 */
export function layeredDb(
  live: OverlayDb,
  layerOf: (table: string) => Promise<TableLayer | null>,
  options: LayeredOptions = {},
): OverlayDb {
  const keyOf = options.keyOf ?? (() => 'id');

  async function list(table: string, query: DbListQuery): Promise<Row[]> {
    const layer = await layerOf(table);
    if (!layer || layer.size === 0) return live.list(table, query);
    const key = keyOf(table);
    const names = namesOf(query.columns);
    // What a filter, the order and the key need, beside what the caller asked for.
    const needed = names
      ? [
          ...new Set([
            ...names,
            key,
            ...Object.keys(query.eq ?? {}),
            ...Object.keys(query.in ?? {}),
            ...(query.order ? [query.order.column] : []),
          ]),
        ].join(',')
      : '*';
    const touched = [...layer.keys()];
    const edited = [...layer.entries()]
      .filter(([, change]) => change.op === 'update')
      .map(([id]) => id);
    const [rows, editedRows] = await Promise.all([
      // Live's own answer, with room for the rows the layer takes out of it.
      live.list(table, {
        ...query,
        columns: needed,
        ...(query.limit !== undefined ? { limit: query.limit + touched.length } : {}),
      }),
      // An edited row is judged on its new values, whatever live's filter said of its old ones.
      edited.length > 0
        ? live.list(table, { columns: '*', in: { [key]: edited } })
        : Promise.resolve([] as Row[]),
    ]);
    const out: Row[] = rows.filter((row) => !layer.has(String(row[key])));
    for (const row of editedRows) {
      const change = layer.get(String(row[key]));
      if (change?.op !== 'update') continue;
      const merged = { ...row, ...change.patch };
      if (matchesFilters(merged, query)) out.push(merged);
    }
    for (const change of layer.values()) {
      if (change.op === 'create' && matchesFilters(change.row, query)) out.push({ ...change.row });
    }
    if (query.order) out.sort(compareBy(query.order.column, query.order.ascending ?? true));
    const limited = query.limit !== undefined ? out.slice(0, query.limit) : out;
    return limited.map((row) => project(row, names));
  }

  return {
    async exists(table, id, where = {}) {
      if (options.existsLiveFirst && (await live.exists(table, id, where))) return true;
      const layer = await layerOf(table);
      const change = layer?.get(id);
      if (!change) return options.existsLiveFirst ? false : live.exists(table, id, where);
      if (change.op === 'delete') return false;
      if (change.op === 'create') return matchesFilters(change.row, { eq: where });
      // An edit: judge `where` on the new values, live's for the columns it leaves alone.
      const columns = Object.keys(where);
      if (columns.length === 0) {
        return options.existsLiveFirst ? false : live.exists(table, id);
      }
      const [row] = await live.list(table, {
        columns: [...new Set([keyOf(table), ...columns])].join(','),
        eq: { [keyOf(table)]: id },
        limit: 1,
      });
      return row ? matchesFilters({ ...row, ...change.patch }, { eq: where }) : false;
    },
    list,
    async first(table, query) {
      const layer = await layerOf(table);
      if (!layer || layer.size === 0) return live.first(table, query);
      const [row] = await list(table, { ...query, limit: 1 });
      return row ?? null;
    },
  };
}

/** A layer from a fixed set of changes (a release's selection). */
export function fixedLayers(
  layers: ReadonlyMap<string, TableLayer>,
): (table: string) => Promise<TableLayer | null> {
  return async (table) => layers.get(table) ?? null;
}

// ---- memo -----------------------------------------------------------------------------------

/** A database whose answers are kept for the request, and can be primed from a batched read. */
export interface MemoDb extends OverlayDb {
  primeExists(
    table: string,
    id: string,
    where: Readonly<Record<string, string | number | boolean>>,
    found: boolean,
  ): void;
  primeFirst(table: string, query: DbListQuery, row: Row | null): void;
}

const keyFor = (...parts: unknown[]): string => JSON.stringify(parts);
const sortedEntries = (record: Readonly<Record<string, unknown>> | undefined) =>
  Object.entries(record ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
const queryKey = (table: string, query: DbListQuery) =>
  keyFor(
    table,
    query.columns,
    sortedEntries(query.eq),
    sortedEntries(query.in),
    query.order ?? null,
    query.limit ?? null,
  );

/**
 * Every answer kept for this request (Admin v2 R6, P-15): a publish judges up to 60 changes,
 * and each rule asks about its own links; with the answers primed from one read per table, a
 * release costs a handful of subrequests rather than one per rule per change (the Free plan
 * allows 50).
 */
export function memoDb(inner: OverlayDb): MemoDb {
  const exists = new Map<string, Promise<boolean>>();
  const lists = new Map<string, Promise<Row[]>>();
  const firsts = new Map<string, Promise<Row | null>>();
  const remember = <T>(cache: Map<string, Promise<T>>, key: string, run: () => Promise<T>) => {
    let hit = cache.get(key);
    if (!hit) {
      hit = run();
      cache.set(key, hit);
      // A failed read is not remembered: the next asker tries again (and fails the same way).
      hit.catch(() => cache.delete(key));
    }
    return hit;
  };
  return {
    exists: (table, id, where = {}) =>
      remember(exists, keyFor(table, id, sortedEntries(where)), () =>
        inner.exists(table, id, where),
      ),
    list: (table, query) => remember(lists, queryKey(table, query), () => inner.list(table, query)),
    first: (table, query) =>
      remember(firsts, queryKey(table, query), () => inner.first(table, query)),
    primeExists(table, id, where, found) {
      exists.set(keyFor(table, id, sortedEntries(where)), Promise.resolve(found));
    },
    primeFirst(table, query, row) {
      firsts.set(queryKey(table, query), Promise.resolve(row));
    },
  };
}
