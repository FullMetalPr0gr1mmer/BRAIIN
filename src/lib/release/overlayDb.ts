import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '@/lib/auth/types';

// The database as a domain rule should see it (Admin v2 R6; docs/admin-v2/releases.md §3,
// "assertWritable/assertPublishable receive ctx.db: OverlayDb"). The rules that read other rows
// (a link names a row of this site; a redirect's chain and the live routes it must not shadow)
// ask through this seam, so the same rule judges:
//   • a save while releases are off: `liveDb`, which sends exactly the queries the rules sent
//     before R6 (tests/lib/overlayDb.spec.ts pins them, and the call-for-call kernel specs stay
//     unchanged);
//   • a staged save (R3): `pendingDb`, live with every other pending change of the tenant laid
//     over it (the saved item's own draft left out), so a link to a pending create, or a redirect over a slug a pending change renames, is
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
  /**
   * Several reads at once, answered in order (Admin v2 R7, O-16): the live database sends the
   * ones `public.release_read_rows` serves as ONE request, so a publish's check costs a request
   * for all the tables it reads rather than one per table.
   */
  listMany(queries: readonly TableQuery[]): Promise<Row[][]>;
}

/** One read of `listMany`. */
export interface TableQuery {
  table: string;
  query: DbListQuery;
}

/** One change laid over live: a new row (whole), an edit (its columns), or a removal. */
export type LayerChange =
  { op: 'create'; row: Row } | { op: 'update'; patch: Row } | { op: 'delete' };

/** The changes to one table, by key. */
export type TableLayer = ReadonlyMap<string, LayerChange>;

// ---- one request for many reads (Admin v2 R7, O-16) ----------------------------------------

/** Reads one `release_read_rows` request carries at most (0103 holds the same literal). */
export const RELEASE_READS_MAX = 40;
/** Ids one read carries at most (0103 holds the same literal). */
export const RELEASE_READ_IDS_MAX = 500;
/**
 * Ids one request carries at most, over all its reads (0103 holds the same literal): each id
 * names one row at most, so a request answers 2,000 rows at most however its reads repeat.
 */
export const RELEASE_READ_TOTAL_IDS_MAX = 2_000;
/**
 * The tables read by `tenant_id`: the per-tenant singletons, one row a tenant (the registry's
 * `key: 'tenant_id'`; tests/lib/overlayDb.spec.ts holds them equal). 0103 refuses a
 * `tenant_id` read of any other table, which would be the whole table in one read.
 */
export const RELEASE_SINGLETON_TABLES: readonly string[] = [
  'form_settings',
  'seo_defaults',
  'site_profile',
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLUMN = /^[a-z_][a-z0-9_]{0,62}$/;

/** A read the batched RPC can answer exactly as PostgREST would, as its arguments; else null. */
function batchRead(
  table: string,
  query: DbListQuery,
): { table: string; columns: string[]; key: 'id' | 'tenant_id'; ids: string[] } | null {
  if (Object.keys(query.eq ?? {}).length > 0 || query.order || query.limit !== undefined) {
    return null;
  }
  const filters = Object.entries(query.in ?? {});
  if (filters.length !== 1) return null;
  const [key, values] = filters[0]!;
  if (key !== 'id' && key !== 'tenant_id') return null;
  if (key === 'tenant_id' && !RELEASE_SINGLETON_TABLES.includes(table)) return null;
  if (!values.every((v) => UUID.test(v))) return null;
  const names = namesOf(query.columns);
  const columns = names ?? ['*'];
  if (names && !names.every((n) => COLUMN.test(n))) return null;
  return { table, columns, key, ids: [...values] };
}

/**
 * `public.release_read_rows` (0103): many reads in one request, as the caller (SECURITY
 * INVOKER: RLS, the RESTRICTIVE gates and the column grants bind as for a PostgREST read),
 * in the caller's tenant. Past 40 reads, 500 ids a read or 2,000 ids in all, it takes more
 * than one request.
 */
async function readRows(
  sb: Db,
  tenantId: string,
  reads: readonly { table: string; columns: string[]; key: 'id' | 'tenant_id'; ids: string[] }[],
): Promise<Row[][]> {
  // Each read split into chunks of at most 500 ids.
  const chunks: { read: number; table: string; columns: string[]; key: string; ids: string[] }[] =
    [];
  reads.forEach((read, index) => {
    for (let at = 0; at < read.ids.length; at += RELEASE_READ_IDS_MAX) {
      chunks.push({ ...read, read: index, ids: read.ids.slice(at, at + RELEASE_READ_IDS_MAX) });
    }
  });
  // The chunks in order, a request closed before it would pass 40 reads or 2,000 ids.
  const batches: (typeof chunks)[] = [];
  let open: typeof chunks = [];
  let ids = 0;
  for (const chunk of chunks) {
    if (
      open.length === RELEASE_READS_MAX ||
      (open.length > 0 && ids + chunk.ids.length > RELEASE_READ_TOTAL_IDS_MAX)
    ) {
      batches.push(open);
      open = [];
      ids = 0;
    }
    open.push(chunk);
    ids += chunk.ids.length;
  }
  if (open.length > 0) batches.push(open);
  const out: Row[][] = reads.map(() => []);
  for (const batch of batches) {
    const { data, error } = await sb.rpc('release_read_rows', {
      p_tenant: tenantId,
      p_reads: batch.map(({ table, columns, key, ids }) => ({ table, columns, key, ids })),
    });
    if (error) throw new Error(`read ${batch.map((c) => c.table).join(',')}: ${error.message}`);
    if (!Array.isArray(data) || data.length !== batch.length) {
      throw new Error('read: release_read_rows answered in the wrong shape');
    }
    batch.forEach((chunk, n) => {
      const rows = (data as unknown[])[n];
      if (!Array.isArray(rows))
        throw new Error('read: release_read_rows answered in the wrong shape');
      out[chunk.read]!.push(...(rows as Row[]));
    });
  }
  return out;
}

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
  const db: OverlayDb = {
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
    async listMany(queries) {
      // The reads the RPC serves go in one request (an empty `in` reads nothing and asks
      // nothing); the rest (an order, a limit, another filter) as the list above sends them.
      const batched: { index: number; read: NonNullable<ReturnType<typeof batchRead>> }[] = [];
      const out: (Row[] | Promise<Row[]>)[] = queries.map(({ table, query }, index) => {
        const read = batchRead(table, query);
        if (!read) return db.list(table, query);
        if (read.ids.length === 0) return [];
        batched.push({ index, read });
        return [];
      });
      if (batched.length > 0) {
        const rows = await readRows(
          sb,
          auth.tenantId,
          batched.map((b) => b.read),
        );
        batched.forEach((b, n) => {
          out[b.index] = rows[n]!;
        });
      }
      return Promise.all(out);
    },
  };
  return db;
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

  /**
   * A read over the layer, as the live reads it needs and how their answers combine (list
   * runs the reads itself; listMany sends every plan's reads in one go).
   */
  async function plan(
    table: string,
    query: DbListQuery,
  ): Promise<{ reads: TableQuery[]; finish: (answers: Row[][]) => Row[] }> {
    const layer = await layerOf(table);
    if (!layer || layer.size === 0) {
      return { reads: [{ table, query }], finish: (answers) => answers[0] ?? [] };
    }
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
    const reads: TableQuery[] = [
      // Live's own answer, with room for the rows the layer takes out of it.
      {
        table,
        query: {
          ...query,
          columns: needed,
          ...(query.limit !== undefined ? { limit: query.limit + touched.length } : {}),
        },
      },
    ];
    // An edited row is judged on its new values, whatever live's filter said of its old ones.
    if (edited.length > 0) reads.push({ table, query: { columns: '*', in: { [key]: edited } } });
    const finish = (answers: Row[][]): Row[] => {
      const rows = answers[0] ?? [];
      const editedRows = edited.length > 0 ? (answers[1] ?? []) : [];
      const out: Row[] = rows.filter((row) => !layer.has(String(row[key])));
      for (const row of editedRows) {
        const change = layer.get(String(row[key]));
        if (change?.op !== 'update') continue;
        const merged = { ...row, ...change.patch };
        if (matchesFilters(merged, query)) out.push(merged);
      }
      for (const change of layer.values()) {
        if (change.op === 'create' && matchesFilters(change.row, query)) {
          out.push({ ...change.row });
        }
      }
      if (query.order) out.sort(compareBy(query.order.column, query.order.ascending ?? true));
      const limited = query.limit !== undefined ? out.slice(0, query.limit) : out;
      return limited.map((row) => project(row, names));
    };
    return { reads, finish };
  }

  async function list(table: string, query: DbListQuery): Promise<Row[]> {
    const { reads, finish } = await plan(table, query);
    return finish(await Promise.all(reads.map((r) => live.list(r.table, r.query))));
  }

  async function listMany(queries: readonly TableQuery[]): Promise<Row[][]> {
    const plans = await Promise.all(queries.map((q) => plan(q.table, q.query)));
    const answers = await live.listMany(plans.flatMap((p) => p.reads));
    let at = 0;
    return plans.map((p) => {
      const mine = answers.slice(at, at + p.reads.length);
      at += p.reads.length;
      return p.finish(mine);
    });
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
    listMany,
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
    listMany(queries) {
      // The reads not answered yet go to the inner database together; each is remembered as
      // `list` would remember it, so a later `list` of the same read costs nothing.
      const keys = queries.map((q) => queryKey(q.table, q.query));
      const missing: number[] = [];
      keys.forEach((key, index) => {
        if (!lists.has(key) && !missing.some((m) => keys[m] === key)) missing.push(index);
      });
      if (missing.length > 0) {
        const run = inner.listMany(missing.map((index) => queries[index]!));
        missing.forEach((index, n) => {
          const key = keys[index]!;
          const hit = run.then((answers) => answers[n] ?? []);
          lists.set(key, hit);
          hit.catch(() => lists.delete(key));
        });
      }
      return Promise.all(keys.map((key) => lists.get(key)!));
    },
    primeExists(table, id, where, found) {
      exists.set(keyFor(table, id, sortedEntries(where)), Promise.resolve(found));
    },
    primeFirst(table, query, row) {
      firsts.set(queryKey(table, query), Promise.resolve(row));
    },
  };
}
