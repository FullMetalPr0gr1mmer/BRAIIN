// The shapes of the admin's editor descriptors (Admin v2 W0: one module per entity in
// this directory, registered in ./index.ts). Presentation only, and Zod-free: these ship
// in the admin client bundle.

export type FieldKind =
  | 'text'
  | 'slug'
  | 'bilingual' // {en, ar} — both required
  | 'prose' // {en, ar?} — multiline, AR may lag
  | 'textarea' // plain multiline string (no locale split)
  | 'richtext' // locale-keyed Tiptap
  | 'select'
  | 'checkbox'
  | 'number'
  | 'url'
  | 'datetime'
  | 'tags'
  | 'json'
  // UI v2 (PR3): composite and referencing kinds
  | 'relation' // one row of another resource, by id (a <select> loaded from its API)
  | 'multiRelation' // an ORDERED list of ids of another resource
  | 'multiSelect' // several of `options`, as a string array
  | 'media' // one media asset id, chosen in a <dialog> picker
  | 'repeater' // an array of objects, each edited with `itemFields`
  // Round 3: a fixed-shape object ({value, label} — the proof band's rating line), edited
  // with `itemFields` like one repeater item; omitted from the payload while all blank
  | 'object'
  | 'clip' // a video clip: a Stream UID or a /media/*.mp4 path, plus a ≤30s window
  | 'sectionContent' // page_sections.content, typed by the sibling `type` field
  | 'upload'; // a file sent to `upload.endpoint`; the field holds the returned id

/**
 * One filter of a relation's options query: a value means "equals", `{ neq }` means "is
 * not" — e.g. `{ status: { neq: 'archived' } }` keeps archived rows out of a picker.
 */
export type RelationFilterValue = string | { readonly neq: string };

/** Where a relation field loads its options from. */
export interface RelationDef {
  /** Admin API resource slug: options load from GET /api/admin/<resource>. */
  resource: string;
  /** Row key shown as the option label; a {en, ar} value shows its English. */
  labelKey: string;
  /** Options-query filters: { location: 'header' } (equals), { status: { neq: 'archived' } }. */
  filter?: Readonly<Record<string, RelationFilterValue>>;
}

export interface FieldDef {
  /** camelCase name sent to the API. */
  name: string;
  label: string;
  kind: FieldKind;
  /** Row key returned by the API. Defaults to snake_case(name). */
  column?: string;
  options?: readonly { value: string; label: string }[];
  help?: string;
  required?: boolean;
  /**
   * An all-blank bilingual/prose value is sent as `null` ("none") instead of
   * `{en:'', ar:''}`. Opt-in, and only for fields whose schema AND column accept null
   * (site_profile's legal name / city): most bilingual columns are NOT NULL, and a null
   * there would turn every blank save into a 422.
   */
  nullable?: boolean;
  /** `relation` / `multiRelation`: the resource the ids point at. */
  relation?: RelationDef;
  /** `repeater`: the fields of one item; `object`: the fields of the object. */
  itemFields?: readonly FieldDef[];
  /** `repeater` / `multiRelation` / `multiSelect`: the most items the schema accepts. */
  maxItems?: number;
  /** `sectionContent`: the sibling field holding the section type (default 'type'). */
  typeField?: string;
  /** `upload`: where the file is POSTed (multipart) and what it may be. */
  upload?: { endpoint: string; accept: string };
  /**
   * `clip`: offer only a site file (/media/….mp4) — for tables with no Stream-uid column
   * yet (disciplines, services: 0028). Stream arrives with KAN-20.
   */
  pathOnly?: boolean;
  /**
   * The value a NEW record's form starts with — must equal the create schema's default, or
   * the form shows one thing (an unticked box) while the server stores another.
   */
  defaultValue?: unknown;
}

export interface ColumnDef {
  key: string;
  label: string;
  kind?: 'status' | 'date' | 'bilingual' | 'text' | 'boolean';
}

/**
 * A table whose rows are snapshotted somewhere the public request path reads (redirects
 * → KV, Round 3). `endpoint` answers GET `{ db, edge }` for the status line and POST
 * `{ kvSynced, count, truncated }` to rebuild the snapshot by hand.
 */
export interface SyncActionDef {
  endpoint: string;
  label: string;
}

export interface ResourceUi {
  /** URL segment for both /admin/<slug> and /api/admin/<slug>. */
  slug: string;
  title: string;
  singular: string;
  columns: readonly ColumnDef[];
  fields: readonly FieldDef[];
  /** Exposes the publish/schedule controls and the status filter. */
  hasStatus?: boolean;
  /** Exposes drag-free up/down reordering (POSTs to <slug>/reorder). */
  reorder?: boolean;
  /** Exposes a "push to the edge" button and its status line (ResourceTable). */
  syncAction?: SyncActionDef;
}

export interface SingletonUi {
  endpoint: string;
  title: string;
  fields: readonly FieldDef[];
}
