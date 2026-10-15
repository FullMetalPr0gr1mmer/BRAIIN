import type { ContentDraftRow, DraftOp } from '@schemas/release';
import { ValidationError } from '@/lib/admin/errors';
import { jsonEqual } from './deepEqual';
import type { RegistryEntry } from './registry';

// The one place a pending change is merged, turned into columns and laid over the live
// site (Admin v2 R2; docs/admin-v2/releases.md §2.8, §3, §4.5). Pure functions over plain
// rows: no database call here. R3's staged writes, R6's publish and R8's preview call them.
//
// A draft's payload is UNTRUSTED (anyone with the entity's write role can write one
// through the API, A3-13): every function that turns it into columns parses it again with
// the entity's own schema and `toRow`, the same two steps a save takes today.

type Row = Record<string, unknown>;
type Payload = Record<string, unknown>;

/**
 * A patch named a column the registry's allowlist does not hold: the TypeScript configs
 * and app.release_entities disagree. A 500, loudly (the apply would refuse the column with
 * 22023 anyway); tests/lib/resourceFields.spec.ts exists so this never fires.
 */
export class RegistryDriftError extends Error {
  readonly status = 500 as const;
  constructor(
    readonly entityType: string,
    readonly columns: readonly string[],
  ) {
    super(
      `release registry drift: ${entityType} wrote ${columns.join(', ')} outside its allowlist`,
    );
    this.name = 'RegistryDriftError';
  }
}

/** The payload keys whose columns are all immediate (never staged, e.g. the intake switch). */
function immediateKeys(entry: RegistryEntry): Set<string> {
  const immediate = new Set(entry.immediateColumns);
  return new Set(
    Object.entries(entry.fields)
      .filter(([, columns]) => columns.length > 0 && columns.every((c) => immediate.has(c)))
      .map(([key]) => key),
  );
}

/**
 * One save merged into the pending change: a shallow merge of camelCase keys, as a PATCH
 * reads. `undefined` is skipped, `null` kept (clearing a field is an edit); a child set
 * (`serviceIds`, `media`) and every other value replaces the previous one whole. The
 * optimistic-lock fields (`version`, `draftVersion`) are never stored, nor a key the
 * entity does not know, nor one that writes only immediate columns (the job-application
 * switch goes to its own endpoint, never into a release).
 */
export function mergePayload(
  prev: Readonly<Payload> | null | undefined,
  next: Readonly<Payload>,
  entry: RegistryEntry,
): Payload {
  const known = new Set([...Object.keys(entry.fields), ...entry.childKeys]);
  for (const key of immediateKeys(entry)) known.delete(key);
  const out: Payload = {};
  for (const source of [prev ?? {}, next]) {
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined || !known.has(key)) continue;
      out[key] = value;
    }
  }
  return out;
}

export interface DerivedPatch {
  /** The columns a release writes (snake_case), every one in `entry.columns`. */
  patch: Row;
  /** Child sets, kept in the payload's shape (portfolio: `serviceIds`, `media`). */
  children: Payload;
  /** Immediate columns the payload carried: never staged (R3 routes them to their endpoint). */
  exempt: Row;
}

const withoutVersion = (value: unknown): Payload => {
  const { version: _version, draftVersion: _draftVersion, ...rest } = value as Payload;
  return rest;
};

/**
 * A pending change → the columns a release would write, through the entity's own schema
 * and `toRow` (create: the create schema; update: the update schema, which reads a PATCH;
 * a singleton or entity SEO: its one schema). The staged rules on top of `toRow`:
 * - no `published_at`: the apply stamps a first publish (R4), so the legacy path's stamp is
 *   dropped here, and `toRow` keeps stamping for saves while releases are off;
 * - no per-item schedule: a `scheduledFor` or a `scheduled` status is refused, since a
 *   release is what gets scheduled (releases.md §2.8);
 * - immediate columns move to `exempt`;
 * - every remaining column must be in the registry's allowlist, else RegistryDriftError.
 * A delete has no patch. Throws the schema's ZodError (the kernel answers 422) or a
 * ValidationError, as a save does.
 */
export function derivePatch(entry: RegistryEntry, op: DraftOp, payload: Payload): DerivedPatch {
  if (op === 'delete') return { patch: {}, children: {}, exempt: {} };
  const input = withoutVersion(payload);

  let parsed: Payload;
  let values: Row;
  if (entry.kind === 'resource') {
    const config = entry.resource!;
    parsed =
      op === 'create'
        ? (config.createSchema.parse(input) as Payload)
        : withoutVersion(config.updateSchema.parse({ ...input, version: 1 }));
    refuseSchedule(entry, parsed);
    values = config.toRow(parsed);
  } else if (entry.kind === 'singleton') {
    const config = entry.singleton!;
    parsed = withoutVersion(config.schema.parse({ ...input, version: 1 }));
    values = config.toRow(parsed);
    if (op === 'create') {
      // A first save is an INSERT over the table defaults, as singletonRoutes does.
      const defaults = Object.fromEntries(
        Object.entries(config.defaults).filter(([column]) => entry.columns.includes(column)),
      );
      values = { ...defaults, ...values };
    }
  } else {
    const config = entry.entitySeo!;
    const write = config.WriteSchema.parse({ ...input, version: 1 });
    parsed = withoutVersion(write);
    // The target is fixed once the row exists: only a create writes it.
    values = { ...config.toRow(write), ...(op === 'create' ? config.target(write) : {}) };
  }

  const patch: Row = { ...values };
  delete patch['published_at'];
  // Only a null can be left here (refuseSchedule refused a date), and the column is the
  // legacy path's: a release never writes it.
  delete patch['scheduled_for'];

  const exempt: Row = {};
  for (const column of entry.immediateColumns) {
    if (column in patch) {
      exempt[column] = patch[column];
      delete patch[column];
    }
  }

  const drift = Object.keys(patch).filter((column) => !entry.columns.includes(column));
  if (drift.length > 0) throw new RegistryDriftError(entry.entityType, drift);

  const children: Payload = {};
  for (const key of entry.childKeys) {
    if (parsed[key] !== undefined) children[key] = parsed[key];
  }
  return { patch, children, exempt };
}

function refuseSchedule(entry: RegistryEntry, parsed: Payload): void {
  const when = parsed['scheduledFor'];
  if (
    (when !== undefined && when !== null) ||
    (entry.hasStatus && parsed['status'] === 'scheduled')
  ) {
    throw new ValidationError('Schedule the release instead', 'scheduledFor');
  }
}

/**
 * The patch without the columns that already hold the live value; `null` when nothing is
 * left (the pending change is then discarded: saving the live value back is not a change).
 */
export function dropNoOps(patch: Readonly<Row>, live: Readonly<Row>): Row | null {
  const out: Row = {};
  for (const [column, value] of Object.entries(patch)) {
    if (!jsonEqual(value, live[column])) out[column] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * The base of a three-way check: for each column newly in the patch, the live value it
 * started from. An entry already recorded is never overwritten (the base is what the
 * change was made against, not what live became since).
 */
export function recordBase(
  prevBase: Readonly<Row> | null | undefined,
  live: Readonly<Row> | null,
  patch: Readonly<Row>,
): Row {
  const base: Row = { ...(prevBase ?? {}) };
  for (const column of Object.keys(patch)) {
    if (!(column in base)) base[column] = live?.[column] ?? null;
  }
  return base;
}

/**
 * The patch's columns that moved on the live site after the change was made: live no
 * longer equals the recorded base. For display ("Keep mine / Use the live version"); the
 * apply's typed check (R4) decides.
 */
export function conflicts(
  base: Readonly<Row> | null | undefined,
  live: Readonly<Row>,
  patch: Readonly<Row>,
): string[] {
  if (!base) return [];
  return Object.keys(patch).filter(
    (column) => column in base && !jsonEqual(base[column], live[column]),
  );
}

// ---- reading through the pending changes ----------------------------------------------------

/** What a reader is told about the pending change on a row. */
export interface DraftMeta {
  id: string;
  version: number;
  op: DraftOp;
  /** The columns (and child sets) the change writes, re-derived from its payload. */
  fields: string[];
  updatedBy: string | null;
  updatedAt: string;
  /** The scheduled release that has claimed it, if any. */
  releaseId: string | null;
  /** Columns live moved under since the change was made. */
  conflict?: string[];
  /** The live row is gone (removed under the change): offer Discard. */
  liveMissing?: true;
}

export type DraftInput = Pick<
  ContentDraftRow,
  | 'id'
  | 'entity_type'
  | 'entity_id'
  | 'op'
  | 'payload'
  | 'base'
  | 'version'
  | 'created_at'
  | 'updated_at'
  | 'updated_by'
  | 'release_id'
>;

const shape = (entry: RegistryEntry, row: Row): Row => {
  const fromRow = entry.resource?.fromRow;
  return fromRow ? fromRow(row) : row;
};

function meta(draft: DraftInput, derived: DerivedPatch | null): DraftMeta {
  return {
    id: draft.id,
    version: draft.version,
    op: draft.op,
    fields: derived ? [...Object.keys(derived.patch), ...Object.keys(derived.children)] : [],
    updatedBy: draft.updated_by,
    updatedAt: draft.updated_at,
    releaseId: draft.release_id,
  };
}

/** Child sets over a shaped row, under the keys `fromRow` returns them as. */
function withChildren(entry: RegistryEntry, row: Row, children: Payload): Row {
  const out = { ...row };
  for (const [key, value] of Object.entries(children)) {
    out[entry.childRowKeys[key] ?? key] = value;
  }
  return out;
}

/** A pending create's row: its patch, its pre-allocated key, `version: 0`, the draft's times. */
function createdRow(entry: RegistryEntry, draft: DraftInput, patch: Row): Row {
  return {
    ...patch,
    [entry.key]: draft.entity_id,
    version: 0,
    created_at: draft.created_at,
    updated_at: draft.updated_at,
  };
}

/**
 * One row as the admin should show it: live with the pending change laid over it. `live`
 * is the row as selected (before `fromRow`); the result is shaped. An update is live ⊕
 * patch (a row removed under it comes back null with `liveMissing`); a create is its
 * patch with its key and `version: 0`; a delete is live with `pendingRemoval: true`.
 */
export function overlayRow(
  live: Readonly<Row> | null,
  draft: DraftInput,
  entry: RegistryEntry,
): { row: Row | null; draft: DraftMeta } {
  if (draft.op === 'delete') {
    const row = live ? shape(entry, { ...live }) : { [entry.key]: draft.entity_id };
    return { row: { ...row, pendingRemoval: true }, draft: meta(draft, null) };
  }
  const derived = derivePatch(entry, draft.op, draft.payload);
  const info = meta(draft, derived);
  if (draft.op === 'create') {
    const row = shape(entry, createdRow(entry, draft, derived.patch));
    return { row: withChildren(entry, row, derived.children), draft: info };
  }
  if (!live) return { row: null, draft: { ...info, liveMissing: true } };
  const conflict = conflicts(draft.base, live, derived.patch);
  if (conflict.length > 0) info.conflict = conflict;
  const row = shape(entry, { ...live, ...derived.patch });
  return { row: withChildren(entry, row, derived.children), draft: info };
}

/** What a list asked for: the same options `listRows` (src/lib/admin/crud.ts) takes. */
export interface OverlayListQuery {
  filters?: Readonly<Record<string, string | null>>;
  exclude?: Readonly<Record<string, string>>;
  search?: { column: string; term: string } | undefined;
  offset?: number;
  orderBy?: { column: string; ascending?: boolean };
}

/** A column's value, reading `a->>b` (a jsonb key, as PostgREST does) where a list searches one. */
function valueAt(row: Readonly<Row>, column: string): unknown {
  const [head, ...path] = column.split('->>');
  let value: unknown = row[head!];
  for (const key of path) {
    value =
      value && typeof value === 'object' && !Array.isArray(value) ? (value as Row)[key] : undefined;
  }
  return value;
}

/**
 * Whether a (pending) row matches a list query the way PostgREST would: equality and
 * `.neq` compare as text and a NULL matches neither (`col <> 'x'` is NULL in SQL); the
 * search is a case-insensitive substring of the search column, its `%` and `_` literal.
 */
export function matchesQuery(row: Readonly<Row>, query: OverlayListQuery): boolean {
  for (const [column, value] of Object.entries(query.filters ?? {})) {
    const v = valueAt(row, column);
    if (value === null ? v !== null && v !== undefined : v === null || v === undefined) {
      return false;
    }
    if (value !== null && String(v) !== value) return false;
  }
  for (const [column, value] of Object.entries(query.exclude ?? {})) {
    const v = valueAt(row, column);
    if (v === null || v === undefined || String(v) === value) return false;
  }
  const term = query.search?.term ?? '';
  if (query.search && term.length > 0) {
    const v = valueAt(row, query.search.column);
    if (v === null || v === undefined) return false;
    if (!String(v).toLowerCase().includes(term.toLowerCase())) return false;
  }
  return true;
}

/** PostgREST's order: ascending puts NULLs last, descending first. */
function compareBy(column: string, ascending: boolean) {
  return (a: Row, b: Row): number => {
    const x = a[column];
    const y = b[column];
    const xNull = x === null || x === undefined;
    const yNull = y === null || y === undefined;
    if (xNull || yNull) {
      if (xNull && yNull) return 0;
      return xNull === ascending ? 1 : -1;
    }
    const order =
      typeof x === 'number' && typeof y === 'number'
        ? x - y
        : String(x) < String(y)
          ? -1
          : String(x) > String(y)
            ? 1
            : 0;
    return ascending ? order : -order;
  };
}

/** The top-level column names of a PostgREST select list (embeds by their name). */
function selectNames(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of list) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out.map((c) => c.trim().replace(/\(.*$/s, '').split(':')[0]!.trim());
}

const project = (row: Readonly<Row>, keys: Iterable<string>): Row => {
  const out: Row = {};
  for (const key of keys) if (key in row) out[key] = row[key];
  return out;
};

/**
 * A list page as the admin should show it (releases.md §3 "GET list", decision D3):
 * - an update is laid over its live row, which keeps its place on its live page;
 * - a delete stays listed, marked `pendingRemoval`;
 * - a create that matches the query's filters, exclusions, status and search is added to
 *   the FIRST page only (offset 0), and `total` counts every matching create on every page;
 * - the page is then sorted by the list's order (a pending reorder moves its row).
 * Rows come in as selected (before `fromRow`) and leave shaped, with the list's columns
 * only and `draft` meta on each changed row. A draft whose payload no longer parses is left
 * out and its id reported in `invalid` (a malformed draft written around the API).
 */
export function overlayList(
  live: { rows: readonly Row[]; total: number },
  drafts: readonly DraftInput[],
  query: OverlayListQuery,
  entry: RegistryEntry,
): { rows: Row[]; total: number; invalid: string[] } {
  const config = entry.resource;
  if (!config) throw new Error(`overlayList: ${entry.entityType} has no list`);
  const listKeys = selectNames(config.listColumns);
  const own = drafts.filter((d) => d.entity_type === entry.entityType);
  const byEntity = new Map(own.filter((d) => d.op !== 'create').map((d) => [d.entity_id, d]));
  const invalid: string[] = [];

  const rows: Row[] = live.rows.map((liveRow) => {
    const draft = byEntity.get(String(liveRow[entry.key]));
    if (!draft) return shape(entry, { ...liveRow });
    try {
      if (draft.op === 'delete') {
        return { ...shape(entry, { ...liveRow }), pendingRemoval: true, draft: meta(draft, null) };
      }
      const derived = derivePatch(entry, 'update', draft.payload);
      const info = meta(draft, derived);
      const conflict = conflicts(draft.base, liveRow, derived.patch);
      if (conflict.length > 0) info.conflict = conflict;
      const merged = project({ ...liveRow, ...derived.patch }, Object.keys(liveRow));
      return { ...shape(entry, merged), draft: info };
    } catch {
      invalid.push(draft.id);
      return shape(entry, { ...liveRow });
    }
  });

  let created = 0;
  for (const draft of own.filter((d) => d.op === 'create')) {
    let derived: DerivedPatch;
    try {
      derived = derivePatch(entry, 'create', draft.payload);
    } catch {
      invalid.push(draft.id);
      continue;
    }
    const row = createdRow(entry, draft, derived.patch);
    if (!matchesQuery(row, query)) continue;
    created += 1;
    if ((query.offset ?? 0) === 0) {
      rows.push({ ...shape(entry, project(row, listKeys)), draft: meta(draft, derived) });
    }
  }

  const orderBy = query.orderBy ?? config.orderBy;
  rows.sort(compareBy(orderBy.column, orderBy.ascending ?? true));
  return { rows, total: live.total + created, invalid };
}
