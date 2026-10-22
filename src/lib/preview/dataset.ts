import type { SupabaseClient } from '@supabase/supabase-js';
import type { z } from 'zod';
import type { PortfolioMediaItem } from '@schemas/admin';
import {
  ContentDraftRowSchema,
  RELEASE_ENTITY_TYPES,
  type ReleaseEntityType,
} from '@schemas/release';
import { mediaItemToRow } from '@/lib/admin/resources/portfolio';
import type { AuthContext, Role } from '@/lib/auth/types';
import { AuthorizationError } from '@/lib/authz/errors';
import { ROLE_CAPS, type Capability } from '@/lib/authz/matrix';
import type { ContentSource } from '@/lib/data/source';
import { derivePatch, RegistryDriftError, type DerivedPatch } from '@/lib/release/overlay';
import { RELEASE_REGISTRY, type RegistryEntry } from '@/lib/release/registry';
import { createOverlayClient, type OverlayData, type PreviewError } from './client';
import {
  FOREIGN_KEYS,
  isPreviewTable,
  PREVIEW_TABLES,
  TABLE_KEYS,
  type DatasetTable,
  type PreviewTable,
} from './relations';
import { createReport, noteOnce, type InvalidDraft, type PreviewReport } from './report';
import { ANON_COLUMNS, createMirror, visibilityClosure } from './visibility';

// The preview's data (Admin v2 R8; releases.md §6.3 item 3, README "Preview"): for one
// request, the live rows of the signed-in person's tenant with the pending changes they may
// read laid over them, which the emulator (client.ts) answers the public loaders from.
//
// The reader is ONLY the person's own client (`locals.supabase`: the anon key with their
// JWT, under RLS), never the service or anon client, so a preview never shows anyone more
// than their own token reads (tests/lib/contentSource.spec.ts holds src/lib/preview to it).
// Staff read every row of these tables whatever its status (supabase/tests/
// preview_dataset.test.sql pins that); the mirror (visibility.ts) then keeps what a visitor
// would see. One exception: site_integrations (Admin v2 U11) is Admin + SEO only (§5), so a
// Content Creator's or Developer's dataset holds no row of it. No preview emits the Search
// Console tag in any case: a preview is noindex (BaseLayout), and SeoHead reads the code only
// for an indexable home page.
//
// Live rows, lazily per table: the first query that needs a table (directly, through an
// embed, or because a visibility rule reads it) reads it whole, memoised for the request.
// Supabase answers at most `max_rows` (1000 by default) per response, so a table is read in
// pages with `range()` in key order and an exact count, and paging stops at the COUNT, not
// at a short page (a project whose max_rows is lower still reads every row). A table is
// capped (PREVIEW_ROW_CAP, media PREVIEW_MEDIA_ROW_CAP); more rows than that marks the
// render untrusted rather than silently showing a partial table. The six tables anon
// reads by column are read with exactly anon's columns.
//
// Pending changes: one paged read of content_drafts per request, each row parsed. A draft is
// kept when it is the person's tenant's, in `only` (the publish dialog's selection) when
// given, and in an area their role may read (its registry entry's `readCaps` at its
// `readAccess`: Developer sees page drafts through maintenance.manage, not service drafts,
// edge case 16); the others are counted, never listed. A kept draft is parsed again through
// its registry entry (`derivePatch`: the entity's schema and toRow, as a save is) the
// first time its table is read, and one that fails is reported and not shown (edge case
// 13). Redirects, custom themes and page visibility change the edge or the stylesheet, not
// a loader's rows: they are reported as not previewed.
//
// Nothing here is module state: every map lives inside one createPreviewSource() call.

type Row = Record<string, unknown>;

/** Rows read per table at most (releases.md §6.3: 2,000). */
export const PREVIEW_ROW_CAP = 2_000;
/** media_assets rows are narrow and every page references some: a higher cap. */
export const PREVIEW_MEDIA_ROW_CAP = 5_000;
/** Rows asked for per request (Supabase's default max_rows). */
export const PREVIEW_PAGE_SIZE = 1_000;

/** The draft columns the preview reads (never `base`, `label` or the actors). */
export const DRAFT_COLUMNS =
  'id,tenant_id,entity_type,entity_id,op,payload,version,release_id,updated_at';
const DraftSchema = ContentDraftRowSchema.pick({
  id: true,
  tenant_id: true,
  entity_type: true,
  entity_id: true,
  op: true,
  payload: true,
  version: true,
  release_id: true,
  updated_at: true,
});
type Draft = z.infer<typeof DraftSchema>;

/** Registry types whose changes no loader reads: reported as not previewed. */
export const NOT_PREVIEWED_TYPES: readonly ReleaseEntityType[] = [
  'redirect',
  'custom_theme',
  'page_visibility',
];

/**
 * A pending create starts from these column defaults, then its patch: the NOT NULL
 * defaults the visibility rules, the loaders' filters and order, or the loaders' row
 * schemas read, which a create's `toRow` may leave out. Each value is the column's
 * default, pinned against the database by supabase/tests/preview_dataset.test.sql (the
 * literal tests/lib/previewMirror.spec.ts holds equal to this map).
 */
export const CREATE_DEFAULTS: Readonly<Partial<Record<DatasetTable, Readonly<Row>>>> = {
  blog_posts: { status: 'draft' },
  certifications: { status: 'draft', sort_order: 0 },
  clients: { show_in_marquee: false, visible: false, is_placeholder: false, sort_order: 0 },
  disciplines: { status: 'draft', sort_order: 0 },
  entity_seo: { meta_title: {}, meta_description: {} },
  faq_items: { status: 'draft', sort_order: 0 },
  navigation: { visible: true, sort_order: 0, is_key: false },
  page_sections: { content: {}, style: {}, visible: true, sort_order: 0, is_placeholder: false },
  pages: { status: 'draft', nav_visible: true },
  portfolio: {
    status: 'draft',
    sort_order: 0,
    scope: [],
    keywords: [],
    results: [],
    is_featured: false,
    is_placeholder: false,
  },
  sectors: { visible: true, sort_order: 0 },
  seo_defaults: {
    title_template: {},
    default_title: {},
    default_description: {},
    organization: {},
    robots_directives: 'index,follow',
  },
  service_cases: { status: 'draft', problems: [], results: [], is_placeholder: false },
  services: {
    status: 'draft',
    is_teaser: false,
    sort_order: 0,
    value_points: [],
    deliverables: [],
  },
  site_profile: { address_country: 'SA', socials: [], accepting_applications: false },
  statistics: {
    status: 'draft',
    sort_order: 0,
    placements: [],
    placement_labels: {},
    is_placeholder: false,
  },
  team_members: { status: 'draft', sort_order: 0, is_leadership: false, is_placeholder: false },
  testimonials: { status: 'draft', sort_order: 0, placements: [], is_placeholder: false },
};

/**
 * Columns the dataset reads for its own checks on a column-granted table, beyond anon's
 * grant: never answered to a loader (the emulator still says 42501 for them, as PostgREST
 * does for a visitor). A quote's consent record, for 0028's testimonials_consent_gate.
 * Pinned (staff read them) by supabase/tests/preview_dataset.test.sql.
 */
export const DATASET_ONLY_COLUMNS: Readonly<Partial<Record<DatasetTable, readonly string[]>>> = {
  testimonials: ['consent_obtained_at', 'is_placeholder'],
};

/**
 * 0028's testimonials_consent_gate CHECK: a published or scheduled quote has its consent
 * recorded, or is a flagged design sample. A change that breaks it would be refused at
 * publish, so the preview reports it instead of showing it.
 */
function consentHolds(row: Readonly<Row>): boolean {
  return (
    !['published', 'scheduled'].includes(String(row['status'])) ||
    (row['consent_obtained_at'] !== null && row['consent_obtained_at'] !== undefined) ||
    row['is_placeholder'] === true
  );
}

/**
 * The tables whose design samples (`is_placeholder`) 0025's guard keeps off production, and
 * what "live" means on each (0025; service_cases 0028): a status, or a go-live flag.
 */
const SAMPLE_LIVE: Readonly<Partial<Record<DatasetTable, 'status' | 'visible'>>> = {
  portfolio: 'status',
  testimonials: 'status',
  team_members: 'status',
  statistics: 'status',
  service_cases: 'status',
  clients: 'visible',
  page_sections: 'visible',
};

/** Whether a row is a flagged design sample that 0025 would call live. */
function sampleLive(table: DatasetTable, row: Readonly<Row>): boolean {
  const mode = SAMPLE_LIVE[table];
  if (!mode || row['is_placeholder'] !== true) return false;
  return mode === 'status'
    ? ['published', 'scheduled'].includes(String(row['status']))
    : row['visible'] === true;
}

/** Tables with a `published_at` a first publish stamps (R4's `has_published_at`). */
const PUBLISHED_AT_TABLES: readonly DatasetTable[] = [
  'blog_posts',
  'disciplines',
  'pages',
  'portfolio',
  'service_cases',
  'services',
  'testimonials',
];
/** The one preview table without `updated_at`. */
const NO_UPDATED_AT: readonly DatasetTable[] = ['portfolio_services'];

/** Whether a role reads an entity in the admin: any of its readCaps at one of its levels. */
export function readsEntity(role: Role, entry: RegistryEntry): boolean {
  const caps = ROLE_CAPS[role] as Record<Capability, string> | undefined;
  return entry.readCaps.some((cap) => entry.readAccess.includes((caps?.[cap] ?? 'none') as never));
}

/**
 * Every capability that lets a role read some registry entity (at that entity's levels):
 * the preview's door. R9's middleware gates on it first; createPreviewSource checks again.
 */
export const PREVIEW_READ_CAPS: readonly Capability[] = [
  ...new Set(RELEASE_ENTITY_TYPES.flatMap((type) => RELEASE_REGISTRY[type].readCaps)),
];

/** Whether a role may open a preview at all: it reads at least one registry entity. */
export function canPreview(role: Role): boolean {
  return RELEASE_ENTITY_TYPES.some((type) => readsEntity(role, RELEASE_REGISTRY[type]));
}

export interface PreviewSourceOptions {
  /** `locals.supabase`: the signed-in person's own client. */
  supabase: SupabaseClient;
  /** `locals.session`. */
  session: AuthContext | null | undefined;
  /** Draft ids to preview (the publish dialog's selection); every readable draft when absent. */
  only?: readonly string[];
  /** Test seam for the stamps. */
  now?: () => Date;
}

export interface PreviewSource extends ContentSource {
  /** The render's report (live: read it after the render). */
  report(): PreviewReport;
}

interface TableRead {
  rows: Row[];
  error: PreviewError | null;
  truncated: boolean;
}

const asError = (error: unknown): PreviewError => {
  const e = (error ?? {}) as Record<string, unknown>;
  return {
    code: typeof e['code'] === 'string' ? e['code'] : 'PV002',
    message: typeof e['message'] === 'string' ? e['message'] : 'the preview could not read a table',
    details: null,
    hint: null,
  };
};

export function createPreviewSource(opts: PreviewSourceOptions): PreviewSource {
  const { session } = opts;
  if (!session || !session.isActive) throw new AuthorizationError('preview', 'no active session');
  if (!canPreview(session.role)) {
    throw new AuthorizationError(
      PREVIEW_READ_CAPS.join('|'),
      `role '${String(session.role)}' reads no previewable area`,
    );
  }
  const { supabase } = opts;
  const tenantId = session.tenantId;
  const role = session.role;
  const only = opts.only ? new Set(opts.only) : null;
  // One instant for every stamp of this preview: a release applies in one transaction,
  // whose now() is one value (posts published together tie on published_at).
  let instant: string | null = null;
  const now = () => (instant ??= (opts.now ?? (() => new Date()))().toISOString());
  const report = createReport();

  // ---- reading -----------------------------------------------------------------------------

  /** One table, whole, in key order: pages of PREVIEW_PAGE_SIZE until the exact count. */
  async function readAll(
    table: string,
    columns: string,
    keys: readonly string[],
    cap: number,
  ): Promise<TableRead> {
    const rows: Row[] = [];
    for (;;) {
      const from = rows.length;
      const to = Math.min(from + PREVIEW_PAGE_SIZE, cap) - 1;
      let query = supabase.from(table).select(columns, { count: 'exact' });
      for (const key of keys) query = query.order(key, { ascending: true });
      const { data, error, count } = await query.range(from, to);
      if (error) return { rows, error: asError(error), truncated: false };
      if (typeof count !== 'number' || !Array.isArray(data)) {
        return { rows, error: asError({ message: 'no exact count' }), truncated: false };
      }
      rows.push(...(data as unknown as Row[]));
      if (rows.length >= Math.min(count, cap) || data.length === 0) {
        return { rows: rows.slice(0, cap), error: null, truncated: count > cap };
      }
    }
  }

  /** Keeps the person's tenant's rows; counts and drops any other. */
  function ownTenant<T extends { tenant_id?: unknown }>(rows: readonly T[]): T[] {
    return rows.filter((row) => {
      if (row.tenant_id === tenantId) return true;
      report.foreignTenantRows += 1;
      return false;
    });
  }

  // ---- pending changes -----------------------------------------------------------------------

  /** Kept drafts by the table they change, in the order they were last saved. */
  const draftsByTable = new Map<DatasetTable, Draft[]>();
  /** Entity ids a kept delete removes, by table. */
  const deletedIds = new Map<DatasetTable, Set<string>>();
  let draftsLoaded: Promise<PreviewError | null> | null = null;

  async function loadDrafts(): Promise<PreviewError | null> {
    const read = await readAll('content_drafts', DRAFT_COLUMNS, ['id'], PREVIEW_ROW_CAP);
    if (read.error) {
      noteOnce(report.failedTables, 'content_drafts');
      return read.error;
    }
    if (read.truncated) noteOnce(report.truncated, 'content_drafts');
    const drafts: Draft[] = [];
    for (const raw of ownTenant(read.rows)) {
      const r = raw as Row;
      if (only && !only.has(String(r['id']))) continue;
      // An area the person may not read is counted, never listed, malformed or not.
      const type = String(r['entity_type']);
      const entry = (RELEASE_ENTITY_TYPES as readonly string[]).includes(type)
        ? RELEASE_REGISTRY[type as ReleaseEntityType]
        : null;
      if (!entry || !readsEntity(role, entry)) {
        report.draftsNotShown += 1;
        continue;
      }
      const parsed = DraftSchema.safeParse(raw);
      if (!parsed.success) {
        report.pending += 1;
        report.invalid.push({
          draftId: String(r['id'] ?? ''),
          entityType: type,
          entityId: String(r['entity_id'] ?? ''),
          reason: 'invalid',
        });
        continue;
      }
      drafts.push(parsed.data);
    }
    drafts.sort((a, b) =>
      a.updated_at === b.updated_at ? (a.id < b.id ? -1 : 1) : a.updated_at < b.updated_at ? -1 : 1,
    );
    for (const draft of drafts) {
      const entry = RELEASE_REGISTRY[draft.entity_type];
      report.pending += 1;
      if (NOT_PREVIEWED_TYPES.includes(draft.entity_type) || !isPreviewTable(entry.table)) {
        noteOnce(report.notPreviewed, draft.entity_type);
        continue;
      }
      const table = entry.table;
      draftsByTable.set(table, [...(draftsByTable.get(table) ?? []), draft]);
      if (draft.op === 'delete') {
        const ids = deletedIds.get(table) ?? new Set<string>();
        ids.add(draft.entity_id);
        deletedIds.set(table, ids);
      }
    }
    return null;
  }

  /** Each kept draft parsed once (lazily, D9); null when it is reported invalid. */
  const derived = new Map<string, DerivedPatch | null>();
  function derive(draft: Draft): DerivedPatch | null {
    if (derived.has(draft.id)) return derived.get(draft.id)!;
    let out: DerivedPatch | null = null;
    try {
      out = derivePatch(RELEASE_REGISTRY[draft.entity_type], draft.op, draft.payload);
    } catch (err) {
      // The schema's ZodError and the staged rules' ValidationError are the payload's fault,
      // and so is anything else as far as the preview goes: the change is listed, never
      // shown. A column outside the registry's allowlist is drift.
      invalid(draft, err instanceof RegistryDriftError ? 'drift' : 'invalid');
    }
    derived.set(draft.id, out);
    return out;
  }
  function invalid(draft: Draft, reason: InvalidDraft['reason']): void {
    report.invalid.push({
      draftId: draft.id,
      entityType: draft.entity_type,
      entityId: draft.entity_id,
      reason,
    });
  }

  /** R4's stamps: updated_at on a changed row; published_at on a first publish only. */
  function stamp(table: DatasetTable, live: Row | null, next: Row, patch: Row): void {
    const at = now();
    if (!NO_UPDATED_AT.includes(table)) next['updated_at'] = at;
    if (
      PUBLISHED_AT_TABLES.includes(table) &&
      patch['status'] === 'published' &&
      (live?.['published_at'] ?? null) === null
    ) {
      next['published_at'] = at;
    }
  }

  /** Drafts the overlay laid over their own table (a project's links follow only these). */
  const applied = new Set<string>();

  /** A table's live rows with its kept drafts, the deletes' cascades and a project's links. */
  function overlay(table: DatasetTable, live: Row[]): Row[] {
    let rows = live.map((row) => ({ ...row }));
    for (const draft of draftsByTable.get(table) ?? []) {
      const entry = RELEASE_REGISTRY[draft.entity_type];
      const at = rows.findIndex((row) => row[entry.key] === draft.entity_id);
      if (draft.op === 'delete') {
        // A row already gone is the live-missing case (offer Discard), not a change shown.
        if (at === -1) {
          invalid(draft, 'live-missing');
          continue;
        }
        rows.splice(at, 1);
        report.overlaid += 1;
        continue;
      }
      const change = derive(draft);
      if (!change) continue;
      if (draft.op === 'update') {
        const current = rows[at];
        if (!current) {
          invalid(draft, 'live-missing');
          continue;
        }
        if (
          entry.kind === 'entitySeo' &&
          (draft.payload['entityType'] !== current['entity_type'] ||
            draft.payload['entityId'] !== current['entity_id'])
        ) {
          invalid(draft, 'target-changed');
          continue;
        }
        // The key and the tenant stay the live row's, whatever the patch holds (the
        // registry's allowlist keeps both out; this does not rely on it).
        const next: Row = {
          ...current,
          ...change.patch,
          [entry.key]: current[entry.key],
          tenant_id: current['tenant_id'],
        };
        if (table === 'testimonials' && !consentHolds(next)) {
          invalid(draft, 'invalid');
          continue;
        }
        // A change to a project's link sets alone has no column patch: R4 runs no UPDATE
        // then (0051), so the row and its updated_at stay as they are.
        if (Object.keys(change.patch).length > 0) {
          stamp(table, current, next, change.patch);
          rows[at] = next;
          if (sampleLive(table, next)) report.samples += 1;
        }
      } else {
        if (at !== -1) {
          invalid(draft, 'invalid');
          continue;
        }
        const next: Row = {
          ...(CREATE_DEFAULTS[table] ?? {}),
          ...change.patch,
          [entry.key]: draft.entity_id,
          tenant_id: tenantId,
          created_at: now(),
        };
        if (table === 'testimonials' && !consentHolds(next)) {
          invalid(draft, 'invalid');
          continue;
        }
        stamp(table, null, next, change.patch);
        rows.push(next);
        if (sampleLive(table, next)) report.samples += 1;
      }
      applied.add(draft.id);
      report.overlaid += 1;
    }

    // What a pending delete does to the rows that point at the removed one.
    for (const fk of FOREIGN_KEYS) {
      if (fk.table !== table || fk.onDelete === 'restrict') continue;
      const removed = new Set(deletedIds.get(fk.target) ?? []);
      if (removed.size === 0) continue;
      if (fk.onDelete === 'set null') {
        // The database's referential UPDATE fires app.tg_set_updated_at on the child too.
        const bump = NO_UPDATED_AT.includes(table) ? {} : { updated_at: now() };
        rows = rows.map((row) =>
          removed.has(String(row[fk.column])) ? { ...row, [fk.column]: null, ...bump } : row,
        );
        continue;
      }
      // cascade; a self-reference (a menu link's children) cascades down every level
      for (let grew = true; grew;) {
        const before = rows.length;
        const gone = rows.filter((row) => removed.has(String(row[fk.column])));
        rows = rows.filter((row) => !removed.has(String(row[fk.column])));
        grew = fk.target === table && rows.length < before;
        if (grew) for (const row of gone) removed.add(String(row['id']));
      }
    }

    // A case study's link sets, replaced whole as app.apply_portfolio_children does (0051:
    // sort_order is the position, from 0).
    if (table === 'portfolio_services' || table === 'portfolio_media') {
      for (const draft of draftsByTable.get('portfolio') ?? []) {
        // Only a change the project's own overlay showed (loadTable reads the project
        // first): an invalid create over a live project, or an edit of a gone one, sets no
        // links, as its apply would set none.
        if (draft.op === 'delete' || !applied.has(draft.id)) continue;
        const change = derive(draft);
        if (!change) continue;
        const project = draft.entity_id;
        if (table === 'portfolio_services' && Array.isArray(change.children['serviceIds'])) {
          rows = rows.filter((row) => row['portfolio_id'] !== project);
          (change.children['serviceIds'] as string[]).forEach((serviceId, i) => {
            rows.push({
              tenant_id: tenantId,
              portfolio_id: project,
              service_id: serviceId,
              sort_order: i,
            });
          });
        }
        if (table === 'portfolio_media' && Array.isArray(change.children['media'])) {
          rows = rows.filter((row) => row['portfolio_id'] !== project);
          (change.children['media'] as PortfolioMediaItem[]).forEach((item, i) => {
            rows.push({
              ...mediaItemToRow(item),
              tenant_id: tenantId,
              portfolio_id: project,
              sort_order: i,
            });
          });
        }
      }
    }
    return rows;
  }

  // ---- tables ------------------------------------------------------------------------------

  interface Loaded {
    rows: Row[];
    columns: ReadonlySet<string> | null;
    byId: Map<string, Row> | null;
    children: Map<string, Map<string, Row[]>>;
  }
  const loaded = new Map<DatasetTable, Loaded>();
  const loading = new Map<DatasetTable, Promise<PreviewError | null>>();

  /** One table, loaded and overlaid once per request. */
  function load(name: DatasetTable): Promise<PreviewError | null> {
    let pending = loading.get(name);
    if (!pending) {
      pending = loadTable(name);
      loading.set(name, pending);
    }
    return pending;
  }

  async function loadTable(table: DatasetTable): Promise<PreviewError | null> {
    // A project's link sets follow its own overlay, so the project is laid over first.
    if (table === 'portfolio_services' || table === 'portfolio_media') {
      const parent = await load('portfolio');
      if (parent) return parent;
    }
    const granted = ANON_COLUMNS[table];
    const cap = table === 'media_assets' ? PREVIEW_MEDIA_ROW_CAP : PREVIEW_ROW_CAP;
    const projection = granted ? [...granted, ...(DATASET_ONLY_COLUMNS[table] ?? [])] : null;
    const read = await readAll(
      table,
      projection ? projection.join(',') : '*',
      TABLE_KEYS[table],
      cap,
    );
    if (read.error) {
      noteOnce(report.failedTables, table);
      return read.error;
    }
    if (read.truncated) noteOnce(report.truncated, table);
    const live = ownTenant(read.rows);
    const columns = granted ? new Set(granted) : live[0] ? new Set(Object.keys(live[0])) : null;
    loaded.set(table, { rows: overlay(table, live), columns, byId: null, children: new Map() });
    return null;
  }

  function table(name: DatasetTable): Loaded | null {
    const t = loaded.get(name);
    if (!t) {
      // A rule or an embed reached a table the closure did not load: a mirror bug, shown
      // as a refusal (untrusted), never as an empty table.
      noteOnce(report.unsupported, `unloaded ${name}`);
      return null;
    }
    return t;
  }

  const data: OverlayData = {
    async ensure(tables) {
      draftsLoaded ??= loadDrafts();
      const draftError = await draftsLoaded;
      if (draftError) return draftError;
      const errors = await Promise.all([...visibilityClosure(tables)].map(load));
      return errors.find((e) => e !== null) ?? null;
    },
    rows: (name) => table(name)?.rows ?? [],
    byId(name, id) {
      const t = table(name);
      if (!t || id === null || id === undefined) return undefined;
      t.byId ??= new Map(t.rows.map((row) => [String(row['id']), row]));
      return t.byId.get(String(id));
    },
    childrenOf(name, column, id) {
      const t = table(name);
      if (!t || id === null || id === undefined) return [];
      let index = t.children.get(column);
      if (!index) {
        index = new Map();
        for (const row of t.rows) {
          const key = String(row[column]);
          index.set(key, [...(index.get(key) ?? []), row]);
        }
        t.children.set(column, index);
      }
      return index.get(String(id)) ?? [];
    },
    columns: (name) => loaded.get(name)?.columns ?? null,
    mirror: createMirror({
      rows: (name) => table(name)?.rows ?? [],
      byId: (name, id) => data.byId(name, id),
    }),
  };

  const client = createOverlayClient(data, report);
  return {
    client: () => client,
    noteAnonLookup() {
      report.anonLookups += 1;
    },
    report: () => report,
  };
}

/** Every preview table (re-exported for R9's per-route expectations). */
export { PREVIEW_TABLES };
