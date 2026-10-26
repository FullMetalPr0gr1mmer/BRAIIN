import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import {
  type ApplyItem,
  type DraftRef,
  type ReleaseCheckItem,
  type ReleaseIssue,
  type ReleaseWarning,
} from '@schemas/release';
import type { AuthContext } from '@/lib/auth/types';
import { ROLE_CAPS, type Capability } from '@/lib/authz/matrix';
import { ValidationError } from '@/lib/admin/errors';
import { ENTITY_SEO } from '@/lib/admin/entitySeo';
import { isLive } from '@/lib/admin/resource';
import { liveRouteCheck } from '@/lib/admin/redirectRules';
import { mediaItemToRow } from '@/lib/admin/resources/portfolio';
import { HOME_REFUSAL } from '@/lib/admin/visibilityCopy';
import { HOME_SLUG } from '@/lib/visibility/routes';
import { serviceClient } from '@/lib/supabase/server';
import { requiredCaps, waitingFor } from './caps';
import { DRAFT_COLUMNS, parseDraft, type StoredDraft } from './drafts';
import { keyOfTable, selectionLayers } from './layers';
import { RELEASE_LINKS, SEO_TARGET_TABLES, type LinkSpec } from './links';
import { derivePatch, type DerivedPatch } from './overlay';
import {
  fixedLayers,
  layeredDb,
  liveDb,
  memoDb,
  type DbListQuery,
  type LayerChange,
  type MemoDb,
} from './overlayDb';
import { RELEASE_REGISTRY, registryEntry, type RegistryEntry } from './registry';
import { pick, stagedSelect } from './staged';

// Checking a release before it is published (Admin v2 R6; docs/admin-v2/releases.md §4.2 steps 1
// to 5, §4.3, §8). SERVER ONLY. Both endpoints run it: validate answers the report (and, when
// the Worker found nothing to fix, the database's dry run), publish refuses unless it is clean.
//
// In order, each step on every selected change:
//   1. the drafts, read under the publisher's RLS: each must be there, unclaimed, at the version
//      the person saw (else 409 pending-changed, naming them);
//   2. the capabilities the change needs (`requiredCaps`, from ROLE_CAPS: a content type's write
//      capability and `content.publish`, `content.archiveDelete` for a removal, an archive, or
//      a change that keeps an archived row archived), the Worker layer of the two (403 naming
//      the drafts and who could publish them); a null is "no role publishes this" (R2's note),
//      never "nothing needed". The live rows are read first for it (`readLive`, every table in
//      one request, the same read step 4 uses), because whether a row stays archived is live's
//      (hotfix H12: the archive gates refuse that write to anyone but an Admin);
//   3. the person, re-read live (`liveRecheck`, by the caller: a demoted or locked person's
//      token passes RLS for up to an hour, so publishing re-reads them at the moment it runs);
//   4. the change re-derived from its UNTRUSTED payload (the entity's schema and `toRow`, A3-13),
//      its base taken from the draft as stored (the raw PostgREST values: R4 compares them typed),
//      and the state it leaves (live ⊕ change);
//   5. the rules over the state the WHOLE selection leaves (`layeredDb`): every link held to the
//      publisher's tenant, a pending new item left out is a dependency, a parent the release
//      removes refuses its children's changes; the entity's `assertWritable` and, for a row live
//      afterwards, `assertPublishable`; entity SEO's Arabic and target; page visibility's home
//      rule; and the warnings.
// Reads are batched, every table in one request where `public.release_read_rows` serves them
// (Admin v2 R7, O-16), and kept for the request (`memoDb`), so a 60-change release costs a
// handful of subrequests (P-15), not one per rule per change or one per table.

type Row = Record<string, unknown>;

/** A refusal of the whole request, with the body the route answers. */
export class ReleaseRefusal extends Error {
  constructor(
    readonly status: number,
    readonly body: Row,
  ) {
    super(`release refused: ${String(body['error'])}`);
    this.name = 'ReleaseRefusal';
  }
}

/** One selected change, as the check leaves it. */
export interface CheckedItem {
  draft: StoredDraft;
  entry: RegistryEntry;
  report: ReleaseCheckItem;
  /** The change as the apply takes it; null when it cannot be sent (an error says why). */
  apply: ApplyItem | null;
}

export interface SelectionCheck {
  items: CheckedItem[];
  ok: boolean;
}

const Uuid = z.string().uuid();

/** The draft's status as stored, for the capability check (an archive is a removal). */
function storedStatus(draft: StoredDraft): string | null {
  const status = draft.payload['status'];
  return typeof status === 'string' ? status : null;
}

// ---- 1 and 2: the drafts and who may publish them --------------------------------------------

/** The selected drafts, each as the person saw it, or a 409 naming those that moved. */
export async function loadSelection(
  sb: SupabaseClient,
  auth: AuthContext,
  refs: readonly DraftRef[],
): Promise<StoredDraft[]> {
  const { data, error } = await sb
    .from('content_drafts')
    .select(DRAFT_COLUMNS)
    .eq('tenant_id', auth.tenantId)
    .in(
      'id',
      refs.map((r) => r.draftId),
    );
  if (error) throw new Error(`load drafts: ${error.message}`);
  const byId = new Map(((data ?? []) as unknown[]).map((row) => [parseDraft(row).id, row]));
  const drafts: StoredDraft[] = [];
  const moved: string[] = [];
  for (const ref of refs) {
    const row = byId.get(ref.draftId);
    const draft = row ? parseDraft(row) : null;
    if (!draft || draft.version !== ref.draftVersion || draft.release_id !== null) {
      moved.push(ref.draftId);
    } else {
      drafts.push(draft);
    }
  }
  if (moved.length > 0) {
    throw new ReleaseRefusal(409, {
      ok: false,
      error: 'pending-changed',
      entity: 'content_draft',
      draftIds: moved,
    });
  }
  return drafts;
}

/** The live row's status, keyed as `readLive` keys it; null when there is none to read. */
function liveStatusOf(live: ReadonlyMap<string, Row>, draft: StoredDraft): string | null {
  const status = live.get(`${draft.entity_type}:${draft.entity_id}`)?.['status'];
  return typeof status === 'string' ? status : null;
}

/**
 * The Worker's capability check, per change: every capability its publish needs, in full. A
 * 403 names the drafts refused, the first capability missing, and who could publish each.
 * `live` is `readLive` of the same drafts: a change to a row archived live that keeps it
 * archived needs `content.archiveDelete` (`keepsArchived`, hotfix H12).
 */
export function assertMayPublish(
  auth: AuthContext,
  drafts: readonly StoredDraft[],
  live: ReadonlyMap<string, Row>,
): void {
  const refused: { draftId: string; waitingFor: string[] }[] = [];
  let missing: Capability | null = null;
  for (const draft of drafts) {
    const status = storedStatus(draft);
    const ref = {
      entityType: draft.entity_type,
      op: draft.op,
      patch: status ? { status } : null,
      liveStatus: liveStatusOf(live, draft),
    } as const;
    const caps = requiredCaps(ref);
    const lacking = caps === null ? null : caps.find((cap) => ROLE_CAPS[auth.role][cap] !== 'full');
    if (caps === null || lacking) {
      missing ??= lacking ?? RELEASE_REMOVE_LABEL;
      refused.push({ draftId: draft.id, waitingFor: waitingFor(ref) });
    }
  }
  if (refused.length > 0) {
    throw new ReleaseRefusal(403, {
      ok: false,
      error: 'forbidden',
      capability: missing,
      draftIds: refused.map((r) => r.draftId),
      waitingFor: Object.fromEntries(refused.map((r) => [r.draftId, r.waitingFor])),
    });
  }
}

/** The capability a refusal names when no role may publish the change (a singleton's removal). */
const RELEASE_REMOVE_LABEL: Capability = 'content.archiveDelete';

// ---- 4: each change re-derived --------------------------------------------------------------

interface Derived {
  draft: StoredDraft;
  entry: RegistryEntry;
  report: ReleaseCheckItem;
  live: Row | null;
  derived: DerivedPatch | null;
  /** The row as the release leaves it (null for a removal). */
  merged: Row | null;
  patch: Row;
  base: Row;
}

function reportOf(draft: StoredDraft, entry: RegistryEntry): ReleaseCheckItem {
  return {
    draftId: draft.id,
    draftVersion: draft.version,
    entityType: draft.entity_type,
    entityId: draft.entity_id,
    op: draft.op,
    area: entry.area,
    label: draft.label,
    errors: [],
    warnings: [],
    requires: [],
  };
}

const issue = (code: ReleaseIssue['code'], message: string, field?: string): ReleaseIssue =>
  field ? { code, message, field } : { code, message };

/** A thrown rule as an issue on the change, or rethrown when it is not a rule's refusal. */
function asIssue(err: unknown): ReleaseIssue {
  if (err instanceof ValidationError) return issue('invalid', err.detail, err.field);
  if (err instanceof z.ZodError) {
    const first = err.issues[0];
    return issue(
      'invalid',
      first?.message ?? 'This change does not read as valid.',
      first?.path.join('.') || undefined,
    );
  }
  throw err;
}

/**
 * The live rows the selection changes (the whole writable allowlist of each table, the status
 * included), keyed `<entity type>:<id>`, every table in ONE request (`liveDb(...).listMany`,
 * public.release_read_rows: Admin v2 R7, O-16), under the publisher's RLS. Read once per
 * request: the capability check (step 2) and the check over the state the selection leaves
 * (steps 4 and 5) share it.
 */
export async function readLive(
  sb: SupabaseClient,
  auth: AuthContext,
  drafts: readonly StoredDraft[],
): Promise<Map<string, Row>> {
  const byTable = new Map<string, { entry: RegistryEntry; ids: Set<string> }>();
  for (const draft of drafts) {
    const entry = registryEntry(draft.entity_type);
    const group = byTable.get(entry.table) ?? { entry, ids: new Set<string>() };
    group.ids.add(draft.entity_id);
    byTable.set(entry.table, group);
  }
  const groups = [...byTable.values()];
  const answers = await liveDb(sb, auth).listMany(
    groups.map(({ entry, ids }) => ({
      table: entry.table,
      query: {
        columns: stagedSelect(entry, `${entry.key},version`),
        in: { [entry.key]: [...ids] },
      },
    })),
  );
  const out = new Map<string, Row>();
  groups.forEach(({ entry }, index) => {
    for (const row of answers[index] ?? []) {
      out.set(`${entry.entityType}:${String(row[entry.key])}`, row);
    }
  });
  return out;
}

/** The entity-SEO rows that already describe the targets of the selection's new SEO rows. */
async function readSeoTargets(
  sb: SupabaseClient,
  auth: AuthContext,
  drafts: readonly StoredDraft[],
): Promise<Set<string>> {
  const targets = drafts
    .filter((d) => d.entity_type === 'entity_seo' && d.op === 'create')
    .map((d) => d.payload['entityId'])
    .filter((id): id is string => typeof id === 'string' && Uuid.safeParse(id).success);
  if (targets.length === 0) return new Set();
  const { data, error } = await sb
    .from('entity_seo')
    .select('entity_type,entity_id')
    .eq('tenant_id', auth.tenantId)
    .in('entity_id', [...new Set(targets)]);
  if (error) throw new Error(`read entity_seo: ${error.message}`);
  return new Set(
    ((data ?? []) as Row[]).map((r) => `${String(r['entity_type'])}:${String(r['entity_id'])}`),
  );
}

function derive(
  draft: StoredDraft,
  live: Row | null,
  seoTaken: ReadonlySet<string>,
  tenantId: string,
): Derived {
  const entry = registryEntry(draft.entity_type);
  const report = reportOf(draft, entry);
  const out: Derived = {
    draft,
    entry,
    report,
    live,
    derived: null,
    merged: null,
    patch: {},
    base: {},
  };

  if (draft.op === 'delete') {
    if (!live) report.errors.push(issue('removed', 'This is already gone from the live site.'));
    return out;
  }
  if (draft.op === 'update' && !live) {
    report.errors.push(
      issue('removed', 'This item was removed on the live site. Discard the change.'),
    );
    return out;
  }
  if (draft.op === 'create' && live) {
    // R3b's two leftovers: a first save of the identity or SEO defaults whose row an immediate
    // path has since created (the job-application switch), and the same entity id met live.
    report.errors.push(
      issue(
        'exists-live',
        'This was set up on the live site after the change was made. Open it and save again.',
      ),
    );
    return out;
  }

  let derived: DerivedPatch;
  try {
    derived = derivePatch(entry, draft.op, draft.payload);
  } catch (err) {
    if (err instanceof ValidationError || err instanceof z.ZodError) {
      report.errors.push(
        err instanceof ValidationError
          ? asIssue(err)
          : issue('unreadable', 'This change can no longer be read. Open it and save again.'),
      );
      return out;
    }
    throw err;
  }
  out.derived = derived;
  out.patch = derived.patch;

  if (draft.op === 'create') {
    out.merged = { ...derived.patch, [entry.key]: draft.entity_id, tenant_id: tenantId };
    if (draft.entity_type === 'entity_seo') {
      const target = `${String(derived.patch['entity_type'])}:${String(derived.patch['entity_id'])}`;
      if (seoTaken.has(target)) {
        // R3b's other leftover: the page gained its search settings by another path.
        report.errors.push(
          issue(
            'exists-live',
            'This page already has search settings on the live site. Open them and save again.',
          ),
        );
      }
    }
    return out;
  }

  // An update: the base is the draft's own, as stored (the raw PostgREST values, microsecond
  // timestamps included; R4 reads it and compares it typed), for exactly the columns written.
  const columns = Object.keys(derived.patch);
  if (columns.length === 0 && Object.keys(derived.children).length === 0) {
    report.errors.push(issue('nothing', 'This change no longer changes anything. Discard it.'));
    return out;
  }
  const missing = columns.filter((column) => !Object.hasOwn(draft.base, column));
  if (missing.length > 0) {
    report.errors.push(
      issue('base-missing', 'This change was saved in an older way. Open it and save again.'),
    );
    return out;
  }
  out.base = pick(draft.base, columns);
  out.merged = { ...live!, ...derived.patch };
  if (draft.entity_type === 'entity_seo') {
    // The target is fixed once the row exists (R2's note for R4): a change naming another page
    // is not this row's.
    const lookup = ENTITY_SEO.LookupSchema.safeParse(draft.payload);
    if (
      !lookup.success ||
      lookup.data.entityType !== live!['entity_type'] ||
      lookup.data.entityId !== live!['entity_id']
    ) {
      report.errors.push(
        issue('target', 'These search settings were made for another page. Discard the change.'),
      );
    }
  }
  return out;
}

/** The change as `public.apply_release` takes it. */
function applyItemOf(item: Derived): ApplyItem {
  const children = item.derived?.children ?? {};
  const serviceIds = children['serviceIds'];
  const media = children['media'];
  return {
    draft_id: item.draft.id,
    draft_version: item.draft.version,
    entity_type: item.draft.entity_type,
    entity_id: item.draft.entity_id,
    op: item.draft.op,
    patch: item.patch,
    base: item.base,
    ...(serviceIds !== undefined || media !== undefined
      ? {
          children: {
            ...(Array.isArray(serviceIds) ? { service_ids: serviceIds as string[] } : {}),
            ...(Array.isArray(media)
              ? { media: (media as Parameters<typeof mediaItemToRow>[0][]).map(mediaItemToRow) }
              : {}),
          },
        }
      : {}),
  };
}

// ---- 5: the rules over the state the selection leaves ----------------------------------------

/** One link to check: the change, the column's spec and the id it names. */
interface LinkUse {
  item: Derived;
  spec: LinkSpec;
  id: string;
}

/** Every link each change writes, and every link its new row keeps (for a removed parent). */
function linksOf(item: Derived): { written: LinkUse[]; kept: LinkUse[] } {
  const written: LinkUse[] = [];
  const kept: LinkUse[] = [];
  if (!item.merged) return { written, kept };
  const specs: LinkSpec[] = [...(RELEASE_LINKS[item.draft.entity_type] ?? [])];
  if (item.draft.entity_type === 'entity_seo') {
    const table = SEO_TARGET_TABLES[String(item.merged['entity_type'])];
    if (table) specs.push({ column: 'entity_id', table, field: 'entityId', removed: 'cascade' });
  }
  for (const spec of specs) {
    const value = item.merged[spec.column];
    if (typeof value !== 'string' || value === '') continue;
    const use = { item, spec, id: value };
    kept.push(use);
    if (spec.column in item.patch) written.push(use);
  }
  return { written, kept };
}

/**
 * The tables and ids the rules will ask about, primed: every table the publisher reads in ONE
 * request over the state the release leaves (`db.listMany`; Admin v2 R7, O-16), a team member's
 * account apart.
 */
async function primeLinks(
  db: MemoDb,
  sb: SupabaseClient,
  auth: AuthContext,
  uses: readonly LinkUse[],
): Promise<Map<string, Set<string>>> {
  const byTable = new Map<string, { ids: Set<string>; service: boolean }>();
  for (const { spec, id } of uses) {
    if (!Uuid.safeParse(id).success) continue;
    const group = byTable.get(spec.table) ?? { ids: new Set<string>(), service: false };
    group.ids.add(id);
    group.service ||= spec.service === true;
    byTable.set(spec.table, group);
  }
  const found = new Map<string, Set<string>>();
  const groups = [...byTable.entries()].map(([table, { ids, service }]) => ({
    table,
    list: [...ids],
    service,
  }));
  const mine = groups.filter((g) => !g.service);
  // A post's author (U8b, D11): the publish rule asks for the member's status, read here with
  // the ids, under the caller's RLS and through the state the release leaves.
  const isAuthor = (table: string, service: boolean) => table === 'team_members' && !service;
  const columnsOf = (table: string) =>
    table === 'media_assets' ? 'id,kind,alt' : isAuthor(table, false) ? 'id,status' : 'id';
  const [answers, theirs] = await Promise.all([
    db.listMany(
      mine.map(({ table, list }) => ({
        table,
        query: { columns: columnsOf(table), in: { id: list } },
      })),
    ),
    // A team member's account: staff read only their own profile, so existence in the tenant
    // is read with the service client (ids only, nothing returned to anyone).
    Promise.all(
      groups
        .filter((g) => g.service)
        .map((g) =>
          liveDb(serviceClient(), auth).list(g.table, { columns: 'id', in: { id: g.list } }),
        ),
    ),
  ]);
  const rowsOf = new Map<string, Row[]>();
  mine.forEach((g, index) => rowsOf.set(g.table, answers[index] ?? []));
  groups.filter((g) => g.service).forEach((g, index) => rowsOf.set(g.table, theirs[index] ?? []));
  for (const { table, list, service } of groups) {
    const rows = rowsOf.get(table) ?? [];
    const have = new Set(rows.map((r) => String(r['id'])));
    found.set(table, have);
    for (const id of list) db.primeExists(table, id, {}, have.has(id));
    if (isAuthor(table, service)) {
      // requirePublishedAuthor's question (blog.ts), answered for every author at once: one
      // read per release, not one per author (P-15). A member the read cannot see is null,
      // which the rule refuses, as it would have refused the live answer.
      const statusOf = new Map(rows.map((row) => [String(row['id']), row['status'] ?? null]));
      for (const id of list) {
        db.primeFirst(
          table,
          { columns: 'status', eq: { id } },
          statusOf.has(id) ? { status: statusOf.get(id) } : null,
        );
      }
    }
    if (table === 'media_assets') {
      // The poster rules ask "an image of this site" and "its alt text": answered from here.
      for (const row of rows) {
        const id = String(row['id']);
        db.primeExists(table, id, { kind: 'image' }, row['kind'] === 'image');
        db.primeFirst(table, { columns: 'alt', eq: { id } }, { alt: row['alt'] ?? null });
      }
      for (const id of list) {
        if (!have.has(id)) {
          db.primeExists(table, id, { kind: 'image' }, false);
          db.primeFirst(table, { columns: 'alt', eq: { id } }, null);
        }
      }
    }
  }
  return found;
}

/** The redirect rules' live-route reads, one query per detail table, primed. */
async function primeRoutes(db: MemoDb, items: readonly Derived[]): Promise<void> {
  const checks = new Map<string, Map<string, DbListQuery>>();
  for (const item of items) {
    if (item.draft.entity_type !== 'redirect' || !item.merged) continue;
    if (!('source_path' in item.patch)) continue;
    const check = liveRouteCheck(String(item.merged['source_path'] ?? ''));
    if (!check || check === 'static') continue;
    const forTable = checks.get(check.table) ?? new Map();
    forTable.set(check.slug, check.query);
    checks.set(check.table, forTable);
  }
  await Promise.all(
    [...checks.entries()].map(async ([table, slugs]) => {
      const first = [...slugs.values()][0]!;
      const rows = await db.list(table, {
        columns: 'id,slug',
        in: { slug: [...slugs.keys()], ...(first.in ?? {}) },
      });
      for (const [slug, query] of slugs) {
        const row = rows.find((r) => r['slug'] === slug);
        db.primeFirst(table, query, row ? { id: row['id'] } : null);
      }
    }),
  );
}

/** Pending new items (outside the selection) that the missing links name. */
async function pendingCreates(
  sb: SupabaseClient,
  auth: AuthContext,
  ids: readonly string[],
): Promise<
  Map<string, { id: string; version: number; table: string; label: unknown; claimed: boolean }>
> {
  if (ids.length === 0) return new Map();
  const { data, error } = await sb
    .from('content_drafts')
    .select('id,version,entity_type,entity_id,label,release_id')
    .eq('tenant_id', auth.tenantId)
    .eq('op', 'create')
    .in('entity_id', [...new Set(ids)]);
  if (error) throw new Error(`load drafts: ${error.message}`);
  const out = new Map<
    string,
    { id: string; version: number; table: string; label: unknown; claimed: boolean }
  >();
  for (const row of (data ?? []) as Row[]) {
    const entry = (RELEASE_REGISTRY as Readonly<Record<string, RegistryEntry | undefined>>)[
      String(row['entity_type'])
    ];
    if (!entry) continue;
    const table = entry.table;
    out.set(String(row['entity_id']), {
      id: String(row['id']),
      version: Number(row['version']),
      table,
      label: row['label'],
      // Claimed by a scheduled release (R11): it cannot be added to this one.
      claimed: row['release_id'] !== null && row['release_id'] !== undefined,
    });
  }
  return out;
}

const labelText = (label: unknown, fallback: string): string => {
  const en = (label as Row | null)?.['en'];
  return typeof en === 'string' && en.trim() ? en.trim() : fallback;
};

/**
 * Steps 4 and 5 over the selected drafts (already loaded, capability-checked and the person
 * re-read): the report of every change and, for a clean one, its apply item. `live` is the
 * `readLive` the capability check used.
 */
export async function checkSelection(
  sb: SupabaseClient,
  auth: AuthContext,
  drafts: readonly StoredDraft[],
  live: ReadonlyMap<string, Row>,
): Promise<SelectionCheck> {
  const seoTaken = await readSeoTargets(sb, auth, drafts);
  const items = drafts.map((draft) =>
    derive(
      draft,
      live.get(`${draft.entity_type}:${draft.entity_id}`) ?? null,
      seoTaken,
      auth.tenantId,
    ),
  );

  // The state the selection leaves: every change that reads, laid over live.
  const changes: { entry: RegistryEntry; entityId: string; change: LayerChange }[] = [];
  for (const item of items) {
    if (item.draft.op === 'delete' && item.live) {
      changes.push({ entry: item.entry, entityId: item.draft.entity_id, change: { op: 'delete' } });
    } else if (item.draft.op === 'create' && item.merged) {
      changes.push({
        entry: item.entry,
        entityId: item.draft.entity_id,
        change: { op: 'create', row: item.merged },
      });
    } else if (item.draft.op === 'update' && item.merged) {
      changes.push({
        entry: item.entry,
        entityId: item.draft.entity_id,
        change: { op: 'update', patch: item.patch },
      });
    }
  }
  const layers = selectionLayers(changes);
  const removed = (table: string, id: string) => layers.get(table)?.get(id)?.op === 'delete';
  const db = memoDb(layeredDb(liveDb(sb, auth), fixedLayers(layers), { keyOf: keyOfTable }));

  // Links: a parent this release removes refuses the change; a written link must name a row of
  // this site as the release leaves it, or a pending new item to include.
  const written: LinkUse[] = [];
  const kept: LinkUse[] = [];
  for (const item of items) {
    const uses = linksOf(item);
    written.push(...uses.written);
    kept.push(...uses.kept);
  }
  for (const { item, spec, id } of kept) {
    if (removed(spec.table, id)) {
      item.report.errors.push(
        issue(
          'parent-removed',
          spec.removed === 'cascade'
            ? 'What this belongs to is removed in this release. Leave one of the two out.'
            : 'This points at something removed in this release. Leave one of the two out.',
          spec.field,
        ),
      );
    }
  }
  const found = await primeLinks(db, sb, auth, kept);
  const missing = written.filter(
    ({ spec, id }) => !removed(spec.table, id) && !found.get(spec.table)?.has(id),
  );
  const pending = await pendingCreates(
    sb,
    auth,
    missing.map((m) => m.id),
  );
  const selected = new Set(drafts.map((d) => d.id));
  for (const { item, spec, id } of missing) {
    const create = pending.get(id);
    // A selected new item that is not in the state the release leaves could not be read: its
    // own error stops the publish, and this change needs nothing more said.
    if (create && create.table === spec.table && selected.has(create.id)) continue;
    if (create && create.table === spec.table && create.claimed) {
      // R6's departure 9, worded by R11: a scheduled release holds the new item, so it cannot be
      // ticked here; this change waits for that release, or its unscheduling.
      item.report.errors.push(
        issue(
          'requires-scheduled',
          `This needs “${labelText(create.label, 'a new item')}”, which goes live with a scheduled release. Publish this after it does, or unschedule that release first.`,
          spec.field,
        ),
      );
      continue;
    }
    if (create && create.table === spec.table) {
      if (!item.report.requires.some((r) => r.draftId === create.id)) {
        item.report.requires.push({ draftId: create.id, draftVersion: create.version });
      }
      item.report.errors.push(
        issue(
          'requires',
          `This needs “${labelText(create.label, 'a new item')}”, which is not live yet. Include it.`,
          spec.field,
        ),
      );
    } else {
      item.report.errors.push(
        issue(
          spec.column === 'entity_id' ? 'target' : 'link',
          spec.column === 'entity_id'
            ? 'The page these search settings describe is not on this site.'
            : 'That linked item is not on this site. Choose another.',
          spec.field,
        ),
      );
    }
  }

  await primeRoutes(db, items);

  // The entity's own rules, over the state the release leaves.
  for (const item of items) {
    if (!item.merged || item.report.errors.length > 0) continue;
    try {
      await rulesOf(item, { auth, sb, db });
    } catch (err) {
      item.report.errors.push(asIssue(err));
    }
  }

  await warn(db, items);

  const checked: CheckedItem[] = items.map((item) => ({
    draft: item.draft,
    entry: item.entry,
    report: item.report,
    apply:
      item.report.errors.length === 0 && (item.merged || item.draft.op === 'delete')
        ? applyItemOf(item)
        : null,
  }));
  return { items: checked, ok: checked.every((c) => c.report.errors.length === 0) };
}

async function rulesOf(
  item: Derived,
  ctx: { auth: AuthContext; sb: SupabaseClient; db: MemoDb },
): Promise<void> {
  const { entry, merged, patch } = item;
  if (!merged) return;
  if (entry.kind === 'resource') {
    const config = entry.resource!;
    await config.assertWritable?.(merged, { ...ctx, changed: patch });
    if (isLive(config, merged)) await config.assertPublishable?.(merged, ctx);
    return;
  }
  if (entry.kind === 'entitySeo') {
    // Arabic meta is required to publish (Pillar 3), as the legacy save requires it.
    const write = ENTITY_SEO.WriteSchema.parse({ ...item.draft.payload, version: 1 });
    ENTITY_SEO.assertBilingual(write);
    return;
  }
  if (entry.kind === 'pageVisibility') {
    // The legacy save's rules (saveVisibility): the home page stays public, and a page never
    // sends its visitors to itself.
    const pageId = merged['page_id'];
    if (typeof pageId === 'string' && merged['mode'] !== 'public') {
      const page = await ctx.db.first('pages', { columns: 'slug', eq: { id: pageId } });
      if (page?.['slug'] === HOME_SLUG) throw new ValidationError(HOME_REFUSAL, 'mode');
    }
    if (pageId && merged['redirect_page_id'] === pageId) {
      throw new ValidationError('A page cannot send its visitors to itself.', 'redirectPageId');
    }
  }
  // The singletons: their rules are the schema's (step 4); the job-application switch never
  // travels in a release (an immediate column).
}

/** Warnings: a published service whose discipline the release leaves unpublished. */
async function warn(db: MemoDb, items: readonly Derived[]): Promise<void> {
  const services = items.filter(
    (i) =>
      i.draft.entity_type === 'service' &&
      i.report.errors.length === 0 &&
      i.merged?.['status'] === 'published' &&
      typeof i.merged['discipline_id'] === 'string',
  );
  if (services.length === 0) return;
  const ids = [...new Set(services.map((s) => String(s.merged!['discipline_id'])))];
  const rows = await db.list('disciplines', { columns: 'id,status', in: { id: ids } });
  const published = new Set(
    rows.filter((r) => r['status'] === 'published').map((r) => String(r['id'])),
  );
  for (const service of services) {
    if (published.has(String(service.merged!['discipline_id']))) continue;
    const warning: ReleaseWarning = {
      code: 'hidden-by-discipline',
      message: `${labelText(service.draft.label, 'This service')} will stay hidden: its discipline is not published.`,
    };
    service.report.warnings.push(warning);
  }
}
