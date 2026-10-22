// An in-memory stand-in for PostgREST, for the staged-write specs (Admin v2 R3a, R3b): live
// tables, content_drafts, release items and the audit log, `rpc('releases_enabled')`,
// `rpc('staff_directory')`, and `rpc('write_drafts')` emulated with the draft lock's rules (a
// new draft gets a fresh id and version 1; an edit lands on the version it named + 1; a
// claimed draft is untouchable; one draft per entity, one pending entity-SEO create per
// target; all or nothing). Moved out of tests/lib/stagedKernel.spec.ts (R3b) so the singleton,
// entity-SEO and draft-endpoint specs drive the same emulation.

export type Row = Record<string, unknown>;

/** The one tenant the stand-in serves: any other `p_tenant` is refused or answered false. */
export const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

export interface Call {
  kind: 'from' | 'rpc';
  name: string;
  op?: string;
  values?: unknown;
  columns?: string;
}

export interface Db {
  tables: Record<string, Row[]>;
  flag: boolean | 'error';
  calls: Call[];
  user: string;
  now: () => string;
  /** A database error to answer a call with instead of running it (a refusal, a 23505). */
  fail?: (call: Call) => { code: string; message: string } | null | undefined;
  /** Another rpc's answer (R10: `release_as_of`), or undefined for the stand-in's own. */
  rpc?: (fn: string, args: Row) => { data: unknown; error: unknown } | undefined;
}

let seq = 0;
export const freshId = () => `66666666-6666-4666-8666-${String(++seq).padStart(12, '0')}`;
/** Start the fresh ids over (each spec's beforeEach). */
export const resetIds = () => {
  seq = 0;
};

/** A column, or `a->>b` (a jsonb key, as PostgREST reads one). */
function valueAt(row: Row, column: string): unknown {
  const [head, ...path] = column.split('->>');
  let value: unknown = row[head!];
  for (const key of path) {
    value =
      value && typeof value === 'object' && !Array.isArray(value) ? (value as Row)[key] : undefined;
  }
  return path.length > 0 && value !== undefined && value !== null && typeof value !== 'string'
    ? JSON.stringify(value)
    : value;
}

/** The names a select list returns: `alias:source` read from its source, embeds skipped. */
function topNames(list: string): { as: string; from: string }[] | null {
  if (list.trim() === '*') return null;
  const out: { as: string; from: string }[] = [];
  let depth = 0;
  let current = '';
  for (const ch of `${list},`) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      const name = current.trim();
      // An embed (`portfolio_services(…)`) is a join this stand-in does not do.
      if (name && !name.includes('(')) {
        const [as, from] = name.split(':').map((part) => part.trim());
        out.push({ as: as!, from: from ?? as! });
      }
      current = '';
    } else current += ch;
  }
  return out;
}

const project = (row: Row, names: { as: string; from: string }[] | null): Row => {
  if (!names) return { ...row };
  const out: Row = {};
  for (const { as, from } of names) {
    if (from.includes('->>')) out[as] = valueAt(row, from) ?? null;
    else if (from in row) out[as] = row[from];
  }
  return out;
};

type Filter = [kind: 'eq' | 'neq' | 'is' | 'in' | 'ilike' | 'lt', column: string, value: unknown];

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every(([kind, column, value]) => {
    const v = valueAt(row, column);
    if (kind === 'eq') return String(v) === String(value);
    if (kind === 'neq') return v !== null && v !== undefined && String(v) !== String(value);
    if (kind === 'is') return v === value || (value === null && v === undefined);
    if (kind === 'in') return (value as unknown[]).map(String).includes(String(v));
    if (kind === 'lt') return v !== null && v !== undefined && (v as number) < (value as number);
    const term = String(value).replace(/^%|%$/g, '').replace(/\\(.)/g, '$1').toLowerCase();
    return typeof v === 'string' && v.toLowerCase().includes(term);
  });
}

function query(db: Db, table: string) {
  let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
  let values: Row | null = null;
  let columns = '*';
  let returning = false;
  let count = false;
  let order: { column: string; ascending: boolean } | null = null;
  let range: [number, number] | null = null;
  let limit: number | null = null;
  const filters: Filter[] = [];

  const run = (): { data: Row[] | null; error: unknown; count?: number } => {
    const call: Call = { kind: 'from', name: table, op, columns, ...(values ? { values } : {}) };
    db.calls.push(call);
    const failed = db.fail?.(call);
    if (failed) return { data: null, error: failed };
    const rows = (db.tables[table] ??= []);
    if (op === 'insert') {
      const row = { id: freshId(), version: 1, ...values! };
      rows.push(row);
      return { data: [project(row, topNames(columns))], error: null };
    }
    const hit = rows.filter((r) => matches(r, filters));
    if (op === 'update') {
      for (const r of hit) Object.assign(r, values, { version: Number(r['version']) + 1 });
      return { data: returning ? hit.map((r) => project(r, topNames(columns))) : [], error: null };
    }
    if (op === 'delete') {
      db.tables[table] = rows.filter((r) => !hit.includes(r));
      return { data: hit.map((r) => project(r, topNames(columns))), error: null };
    }
    let out = [...hit];
    if (order) {
      const { column, ascending } = order;
      out.sort((a, b) => {
        const x = a[column] as number | string;
        const y = b[column] as number | string;
        return (x < y ? -1 : x > y ? 1 : 0) * (ascending ? 1 : -1);
      });
    }
    const total = out.length;
    if (range) out = out.slice(range[0], range[1] + 1);
    if (limit !== null) out = out.slice(0, limit);
    return {
      data: out.map((r) => project(r, topNames(columns))),
      error: null,
      ...(count ? { count: total } : {}),
    };
  };

  const b: Record<string, unknown> = {
    select(cols = '*', opts?: { count?: string }) {
      columns = cols;
      if (op !== 'select') returning = true;
      count = opts?.count === 'exact';
      return b;
    },
    eq: (c: string, v: unknown) => (filters.push(['eq', c, v]), b),
    neq: (c: string, v: unknown) => (filters.push(['neq', c, v]), b),
    is: (c: string, v: unknown) => (filters.push(['is', c, v]), b),
    in: (c: string, v: unknown[]) => (filters.push(['in', c, v]), b),
    ilike: (c: string, v: unknown) => (filters.push(['ilike', c, v]), b),
    lt: (c: string, v: unknown) => (filters.push(['lt', c, v]), b),
    order: (c: string, o?: { ascending?: boolean }) => (
      (order = { column: c, ascending: o?.ascending ?? true }),
      b
    ),
    range: (from: number, to: number) => ((range = [from, to]), b),
    limit: (n: number) => ((limit = n), b),
    insert: (v: Row) => ((op = 'insert'), (values = v), b),
    update: (v: Row) => ((op = 'update'), (values = v), b),
    delete: () => ((op = 'delete'), b),
    maybeSingle: async () => {
      const r = run();
      return { data: r.data?.[0] ?? null, error: r.error };
    },
    single: async () => {
      const r = run();
      if (r.error) return { data: null, error: r.error };
      return r.data?.[0]
        ? { data: r.data[0], error: null }
        : { data: null, error: { code: 'PGRST116', message: 'no row' } };
    },
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(resolve(run())),
  };
  return b;
}

export const br409 = (code: string, extra: Row = {}) => ({
  data: null,
  error: { code: 'BR409', message: 'conflict', details: JSON.stringify({ code, ...extra }) },
});

const SINGLETON_TYPES = new Set(['site_profile', 'seo_defaults']);

/** write_drafts with the draft lock's rules, all or nothing. */
function writeDraftsRpc(db: Db, args: Row) {
  if (args['p_tenant'] !== T) return { data: null, error: { code: '42501', message: 'tenant' } };
  const ops = [...(args['p_ops'] as Row[])].sort((a, b) =>
    `${a['entity_type'] ?? ''} ${a['entity_id'] ?? ''} ${a['draft_id'] ?? ''}`.localeCompare(
      `${b['entity_type'] ?? ''} ${b['entity_id'] ?? ''} ${b['draft_id'] ?? ''}`,
    ),
  );
  const drafts = structuredClone(db.tables['content_drafts'] ?? []);
  const out: Row[] = [];
  const now = db.now();
  for (const op of ops) {
    const find = () => drafts.find((d) => d['id'] === op['draft_id']);
    // app.draft_key_ok: a singleton's draft is keyed by its tenant (0062), else RLS refuses.
    if (
      op['action'] === 'put' &&
      SINGLETON_TYPES.has(String(op['entity_type'])) &&
      op['entity_id'] !== T
    ) {
      return {
        data: null,
        error: { code: '42501', message: 'new row violates row-level security' },
      };
    }
    if (op['action'] === 'put' && !op['draft_id']) {
      if (
        drafts.some(
          (d) => d['entity_type'] === op['entity_type'] && d['entity_id'] === op['entity_id'],
        )
      ) {
        return br409('draft-conflict');
      }
      // content_drafts_one_seo_create: one pending entity-SEO create per target (0038).
      const target = (d: Row) => {
        const p = (d['payload'] ?? {}) as Row;
        return `${String(p['entityType'])} ${String(p['entityId'])}`;
      };
      if (
        op['entity_type'] === 'entity_seo' &&
        op['op'] === 'create' &&
        drafts.some(
          (d) =>
            d['entity_type'] === 'entity_seo' && d['op'] === 'create' && target(d) === target(op),
        )
      ) {
        return br409('draft-conflict');
      }
      const row: Row = {
        id: freshId(),
        tenant_id: T,
        entity_type: op['entity_type'],
        entity_id: op['entity_id'],
        op: op['op'],
        payload: op['payload'],
        fields: op['fields'],
        base: op['base'],
        base_version: op['base_version'],
        label: op['label'],
        version: 1,
        created_at: now,
        updated_at: now,
        created_by: db.user,
        updated_by: db.user,
        release_id: null,
      };
      drafts.push(row);
      out.push({
        action: 'put',
        draft_id: row['id'],
        entity_type: row['entity_type'],
        entity_id: row['entity_id'],
        version: 1,
      });
      continue;
    }
    const d = find();
    // 0062: an edit matches the draft's entity_type AND entity_id; a discard matches them when it
    // names them. A draft found by id under another entity touches no row → draft-conflict.
    const given = (k: string) => op[k] !== undefined && op[k] !== null;
    const sameEntity =
      !!d &&
      (op['action'] === 'put'
        ? d['entity_type'] === op['entity_type'] && d['entity_id'] === op['entity_id']
        : (!given('entity_type') || d['entity_type'] === op['entity_type']) &&
          (!given('entity_id') || d['entity_id'] === op['entity_id']));
    if (!d || d['release_id'] || d['version'] !== op['expected_version'] || !sameEntity) {
      return br409(d?.['release_id'] ? 'scheduled' : 'draft-conflict');
    }
    if (op['action'] === 'put') {
      Object.assign(d, {
        op: op['op'],
        payload: op['payload'],
        fields: op['fields'],
        base: op['base'],
        base_version: op['base_version'],
        label: op['label'],
        version: Number(d['version']) + 1,
        updated_at: now,
        updated_by: db.user,
      });
      out.push({
        action: 'put',
        draft_id: d['id'],
        entity_type: d['entity_type'],
        entity_id: d['entity_id'],
        version: d['version'],
      });
    } else {
      drafts.splice(drafts.indexOf(d), 1);
      out.push({
        action: 'discard',
        draft_id: d['id'],
        entity_type: d['entity_type'],
        entity_id: d['entity_id'],
        version: null,
      });
    }
  }
  db.tables['content_drafts'] = drafts;
  return { data: out, error: null };
}

export function client(db: Db) {
  return {
    from: (table: string) => query(db, table),
    rpc: async (fn: string, args: Row) => {
      db.calls.push({ kind: 'rpc', name: fn, values: args });
      const failed = db.fail?.({ kind: 'rpc', name: fn, values: args });
      if (failed) return { data: null, error: failed };
      if (fn === 'staff_directory') {
        if (args['p_tenant'] !== T) return { data: [], error: null };
        return { data: structuredClone(db.tables['staff_directory'] ?? []), error: null };
      }
      if (fn === 'releases_enabled') {
        if (args['p_tenant'] !== T) return { data: false, error: null };
        return db.flag === 'error'
          ? { data: null, error: { code: 'PGRST202', message: 'no such function' } }
          : { data: db.flag, error: null };
      }
      if (fn === 'write_drafts') return writeDraftsRpc(db, args);
      const other = db.rpc?.(fn, args);
      if (other) return other;
      return { data: null, error: { code: 'XX000', message: `unexpected rpc ${fn}` } };
    },
  };
}
