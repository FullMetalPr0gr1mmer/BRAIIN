import { z } from 'zod';
import {
  DraftLabelSchema,
  RELEASE_AREAS,
  RELEASE_ENTITY_TYPES,
  WRITE_DRAFTS_MAX_OPS,
  type DiscardRequest,
  type DraftOp,
  type PendingItem,
  type ReleaseArea,
  type ReleaseEntityType,
  type ResolveRequest,
  type WriteDraftsOp,
} from '@schemas/release';
import type { Role } from '@/lib/auth/types';
import { ROLE_CAPS, type Capability } from '@/lib/authz/matrix';
import { json, type AdminRouteContext } from '@/lib/admin/route';
import { DraftConflictError, NotFoundError, ValidationError } from '@/lib/admin/errors';
import { ENTITY_SEO } from '@/lib/admin/entitySeo';
import { RELEASE_ENTITY_META } from './areas';
import { canPublish, requiredCaps, waitingFor, type ReleaseItemRef } from './caps';
import { derivePatch, dropNoOps, overlayRow } from './overlay';
import { RELEASE_REGISTRY, type RegistryEntry } from './registry';
import { DRAFT_COLUMNS, draftFields, parseDraft, writeDrafts, writtenDraft } from './drafts';
import type { StoredDraft } from './drafts';
import { pick, stagedSelect } from './staged';

// The draft endpoints (Admin v2 R3b; docs/admin-v2/releases.md §3 "Draft endpoints", §4.5,
// §4.8): the pending summary, throwing one / mine / selected changes away, and settling a
// conflict. SERVER ONLY (it reaches the registry). Each route is thin; the rules live here.
//
// Two layers decide every item, as for a staged save (Pillar 1):
//   • the Worker: the route admits a caller holding ANY capability that stages something (or
//     reads something, for the summary), then checks each draft against its own entity type:
//     a discard needs the type's author capabilities (`app.can_author`, 0038's delete policy),
//     a resolve, which rewrites the change, what publishing it would need (`requiredCaps`:
//     an archive needs `content.archiveDelete`, as the update policy's archive term does);
//   • the database: every write goes through `public.write_drafts`, so RLS, the RESTRICTIVE
//     live check (0062) and the draft lock bind (a stale token writes nothing; a claimed
//     draft is untouchable).
// The summary reads stored metadata only (never re-parses a payload: up to 1,000 drafts on the
// Free plan's 10 ms), and lists only the entity types the caller may read.

type Row = Record<string, unknown>;
type Ctx = AdminRouteContext<unknown>;

const unique = <T>(list: readonly T[]): T[] => [...new Set(list)];

/** The draft routes admit a caller holding any one of these; each item is checked again. */
export const STAGE_ANY_CAP: readonly Capability[] = unique(
  RELEASE_ENTITY_TYPES.flatMap((type) => RELEASE_ENTITY_META[type].authorCaps),
);

/** The summary admits a caller who may read any release-managed type, at any level. */
export const PENDING_ANY_CAP: readonly Capability[] = unique(
  RELEASE_ENTITY_TYPES.flatMap((type) => RELEASE_REGISTRY[type].readCaps),
);

/** The most pending changes the summary lists (decision D14's cap). */
export const PENDING_LIST_CAP = 1000;

/** May this role stage (and so discard) a change of this type? `app.can_author`'s rule. */
export function mayAuthor(role: Role, type: ReleaseEntityType): boolean {
  return RELEASE_ENTITY_META[type].authorCaps.every((cap) => ROLE_CAPS[role][cap] === 'full');
}

/** May this role read this type in the admin (any read capability, at the entry's levels)? */
export function mayRead(role: Role, entry: RegistryEntry): boolean {
  return entry.readCaps.some((cap) => entry.readAccess.includes(ROLE_CAPS[role][cap]));
}

/** The draft's status as stored (an archive is a removal), never re-parsed. */
function storedStatus(payload: unknown): string | null {
  const status = (payload as Row | null)?.['status'];
  return typeof status === 'string' ? status : null;
}

/** May this role rewrite this pending change (what publishing it would need)? */
export function mayRewrite(role: Role, draft: Pick<StoredDraft, 'entity_type' | 'op' | 'payload'>) {
  const status = storedStatus(draft.payload);
  return canPublish(role, {
    entityType: draft.entity_type,
    op: draft.op,
    patch: status ? { status } : null,
  });
}

/** A 403 that names the drafts refused (the kernel's AuthorizationError names only a cap). */
function refuse(capability: Capability, draftIds: readonly string[]): Response {
  return json({ ok: false, error: 'forbidden', capability, draftIds }, 403);
}

/** A 409 that lists the drafts that moved since the person saw them. */
function pendingChanged(draftIds: readonly string[]): Response {
  return json({ ok: false, error: 'pending-changed', entity: 'content_draft', draftIds }, 409);
}

const Uuid = z.string().uuid();

/** One draft of the caller's tenant, by its id; 404 when it is not there or not visible. */
async function loadDraftById(ctx: Ctx, id: string | undefined): Promise<StoredDraft> {
  if (!id || !Uuid.safeParse(id).success) throw new NotFoundError('content_draft');
  const { data, error } = await ctx.sb
    .from('content_drafts')
    .select(DRAFT_COLUMNS)
    .eq('tenant_id', ctx.auth.tenantId)
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`load draft: ${error.message}`);
  if (!data) throw new NotFoundError('content_draft');
  return parseDraft(data);
}

/**
 * What the audit row names: the entity, or for entity SEO its target (as the legacy save's
 * row does, so the activity log titles the service or post). The payload is untrusted: the
 * target is used only when it reads as one.
 */
function auditTarget(draft: Pick<StoredDraft, 'entity_type' | 'entity_id' | 'payload'>): {
  entityId: string;
  detail: Row;
} {
  if (draft.entity_type !== 'entity_seo') return { entityId: draft.entity_id, detail: {} };
  const target = ENTITY_SEO.LookupSchema.safeParse(draft.payload);
  return target.success
    ? { entityId: target.data.entityId, detail: { target: target.data.entityType } }
    : { entityId: draft.entity_id, detail: {} };
}

const writeTarget = (type: ReleaseEntityType) => ({
  entity: type,
  cap: RELEASE_ENTITY_META[type].authorCaps[0]!,
});

// ---- GET /api/admin/releases/pending ---------------------------------------------------------

interface Tally {
  total: number;
  publishableByMe: number;
  waiting: number;
  mine: number;
}

/** The pending summary: every change the caller may read, who it waits for, counts by area. */
export async function pendingSummary(ctx: Ctx): Promise<Row> {
  const { auth, sb } = ctx;
  const readable = RELEASE_ENTITY_TYPES.filter((type) =>
    mayRead(auth.role, RELEASE_REGISTRY[type]),
  );
  const byArea = Object.fromEntries(
    RELEASE_AREAS.map((area) => [area, { total: 0, publishableByMe: 0, waiting: 0, mine: 0 }]),
  ) as Record<ReleaseArea, Tally>;
  if (readable.length === 0) return { items: [], byArea, total: 0, truncated: false };

  const [drafts, people] = await Promise.all([
    sb
      .from('content_drafts')
      .select(
        'id,entity_type,entity_id,op,fields,label,version,updated_by,updated_at,release_id,status:payload->>status',
      )
      .eq('tenant_id', auth.tenantId)
      .in('entity_type', readable)
      .order('updated_at', { ascending: false })
      .limit(PENDING_LIST_CAP + 1),
    sb.rpc('staff_directory', { p_tenant: auth.tenantId }),
  ]);
  if (drafts.error) throw new Error(`pending drafts: ${drafts.error.message}`);
  // Names are a convenience: without the directory the list still stands, unnamed.
  const names = new Map<string, string | null>();
  if (!people.error && Array.isArray(people.data)) {
    for (const p of people.data as Row[]) {
      if (typeof p['id'] === 'string') {
        names.set(p['id'], typeof p['display_name'] === 'string' ? p['display_name'] : null);
      }
    }
  }

  const rows = (drafts.data ?? []) as unknown as Row[];
  const allowed = new Set<string>(readable);
  // What publishing needs depends on the type, the op and whether it archives: memoised.
  const decided = new Map<
    string,
    Pick<PendingItem, 'publishableByMe' | 'requiredCaps' | 'waitingFor'>
  >();
  const items: PendingItem[] = [];
  for (const row of rows.slice(0, PENDING_LIST_CAP)) {
    const type = row['entity_type'];
    const op = row['op'];
    if (typeof type !== 'string' || !allowed.has(type)) continue;
    if (op !== 'create' && op !== 'update' && op !== 'delete') continue;
    if (typeof row['id'] !== 'string' || typeof row['version'] !== 'number') continue;
    const entityType = type as ReleaseEntityType;
    const status = typeof row['status'] === 'string' ? row['status'] : null;
    const key = `${entityType}|${op}|${status === 'archived'}`;
    let decision = decided.get(key);
    if (!decision) {
      const ref: ReleaseItemRef = {
        entityType,
        op: op as DraftOp,
        patch: status ? { status } : null,
      };
      decision = {
        publishableByMe: canPublish(auth.role, ref),
        requiredCaps: requiredCaps(ref) ? [...requiredCaps(ref)!] : null,
        waitingFor: waitingFor(ref),
      };
      decided.set(key, decision);
    }
    const updatedBy = typeof row['updated_by'] === 'string' ? row['updated_by'] : null;
    const area = RELEASE_ENTITY_META[entityType].area;
    const mine = updatedBy !== null && updatedBy === auth.userId;
    const label = row['label'];
    items.push({
      draftId: row['id'],
      draftVersion: row['version'],
      entityType,
      entityId: String(row['entity_id']),
      op: op as DraftOp,
      area,
      label: label && typeof label === 'object' && !Array.isArray(label) ? (label as Row) : null,
      fields: Array.isArray(row['fields'])
        ? (row['fields'] as unknown[]).filter((f): f is string => typeof f === 'string')
        : [],
      updatedBy,
      updatedByName: updatedBy ? (names.get(updatedBy) ?? null) : null,
      updatedAt: String(row['updated_at']),
      scheduled: row['release_id'] !== null && row['release_id'] !== undefined,
      mine,
      ...decision,
    });
    const tally = byArea[area];
    tally.total += 1;
    if (decision.publishableByMe) tally.publishableByMe += 1;
    else tally.waiting += 1;
    if (mine) tally.mine += 1;
  }
  return { items, byArea, total: items.length, truncated: rows.length > PENDING_LIST_CAP };
}

// ---- DELETE /api/admin/drafts/[id]?version=n -------------------------------------------------

/** Throw one pending change away, at the version the person saw. */
export async function discardOne(ctx: Ctx, id: string | undefined): Promise<Row | Response> {
  const { auth, sb, audit, url } = ctx;
  const version = z.coerce
    .number()
    .int()
    .min(1)
    .safeParse(url.searchParams.get('version') ?? undefined);
  if (!version.success) {
    throw new ValidationError('version must be a positive integer', 'version');
  }
  const draft = await loadDraftById(ctx, id);
  const type = draft.entity_type;
  if (!mayAuthor(auth.role, type)) {
    return refuse(RELEASE_ENTITY_META[type].authorCaps[0]!, [draft.id]);
  }
  if (draft.release_id !== null) throw new DraftConflictError('scheduled', type);
  if (draft.version !== version.data) throw new DraftConflictError('draft-conflict', type);

  await writeDrafts(
    sb,
    auth,
    [
      {
        action: 'discard',
        draft_id: draft.id,
        expected_version: draft.version,
        entity_type: type,
        entity_id: draft.entity_id,
      },
    ],
    writeTarget(type),
  );
  const { entityId, detail } = auditTarget(draft);
  audit({
    action: `${type}.draft_discard`,
    entityType: type,
    entityId,
    detail: { op: draft.op, fields: draft.fields, ...detail },
  });
  return { discarded: draft.id, entityType: type, entityId: draft.entity_id };
}

// ---- POST /api/admin/drafts/discard ----------------------------------------------------------

const LIGHT_COLUMNS = 'id,entity_type,entity_id,op,version,release_id,updated_by';

interface LightDraft {
  id: string;
  entity_type: ReleaseEntityType;
  entity_id: string;
  op: DraftOp;
  version: number;
  release_id: string | null;
}

const LightDraftSchema = z.object({
  id: Uuid,
  entity_type: z.enum(RELEASE_ENTITY_TYPES),
  entity_id: Uuid,
  op: z.enum(['create', 'update', 'delete']),
  version: z.number().int().min(1),
  release_id: Uuid.nullable(),
});

function lightDrafts(data: unknown): LightDraft[] {
  const out: LightDraft[] = [];
  for (const row of (data ?? []) as unknown[]) {
    const parsed = LightDraftSchema.safeParse(row);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/** Throw several pending changes away: all of mine, or the selected ones (all or nothing). */
export async function discardBulk(ctx: Ctx, input: DiscardRequest): Promise<Row | Response> {
  const { auth, sb, audit } = ctx;
  let drafts: LightDraft[];
  let more = false;
  if ('scope' in input) {
    // Mine: the unclaimed changes I last saved, of the types I may stage, oldest first; at
    // most one writer call's worth (200) per request, `more` when others remain.
    const stageable = RELEASE_ENTITY_TYPES.filter((type) => mayAuthor(auth.role, type));
    const { data, error } = await sb
      .from('content_drafts')
      .select(LIGHT_COLUMNS)
      .eq('tenant_id', auth.tenantId)
      .eq('updated_by', auth.userId)
      .is('release_id', null)
      .in('entity_type', stageable)
      .order('updated_at', { ascending: true })
      .limit(WRITE_DRAFTS_MAX_OPS + 1);
    if (error) throw new Error(`my drafts: ${error.message}`);
    const mine = lightDrafts(data);
    more = mine.length > WRITE_DRAFTS_MAX_OPS;
    drafts = mine.slice(0, WRITE_DRAFTS_MAX_OPS);
  } else {
    const ids = input.items.map((item) => item.draftId);
    const { data, error } = await sb
      .from('content_drafts')
      .select(LIGHT_COLUMNS)
      .eq('tenant_id', auth.tenantId)
      .in('id', ids);
    if (error) throw new Error(`selected drafts: ${error.message}`);
    const byId = new Map(lightDrafts(data).map((d) => [d.id, d]));
    // Authorization first: a change the caller may not stage is refused by name.
    const refused = [...byId.values()].filter((d) => !mayAuthor(auth.role, d.entity_type));
    if (refused.length > 0) {
      const cap = RELEASE_ENTITY_META[refused[0]!.entity_type].authorCaps[0]!;
      return refuse(
        cap,
        refused.map((d) => d.id),
      );
    }
    // Then the versions: any change gone, moved or claimed since the person saw it.
    const moved = input.items
      .filter((item) => {
        const d = byId.get(item.draftId);
        return !d || d.version !== item.draftVersion || d.release_id !== null;
      })
      .map((item) => item.draftId);
    if (moved.length > 0) return pendingChanged(moved);
    drafts = input.items.map((item) => byId.get(item.draftId)!);
  }

  if (drafts.length === 0) return { discarded: 0, more: false };
  const ops: WriteDraftsOp[] = drafts.map((d) => ({
    action: 'discard',
    draft_id: d.id,
    expected_version: d.version,
    entity_type: d.entity_type,
    entity_id: d.entity_id,
  }));
  try {
    await writeDrafts(sb, auth, ops, { entity: 'content_draft', cap: STAGE_ANY_CAP[0]! });
  } catch (err) {
    // One moved between the read and the write: nothing was thrown away.
    if (err instanceof DraftConflictError) return pendingChanged(drafts.map((d) => d.id));
    throw err;
  }
  audit({
    action: 'drafts.discard_bulk',
    entityType: 'content_draft',
    detail: {
      count: drafts.length,
      scope: 'scope' in input ? 'mine' : 'selected',
      types: unique(drafts.map((d) => d.entity_type)).sort(),
      draftIds: drafts.map((d) => d.id),
    },
  });
  return { discarded: drafts.length, more };
}

// ---- POST /api/admin/drafts/[id]/resolve -----------------------------------------------------

/** The entity-SEO payload key that writes a meta column (a full replace keeps every key). */
const SEO_KEY_OF: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(ENTITY_SEO.fields).map(([key, columns]) => [columns[0]!, key]),
);

/** The live row a pending change is over, read over the whole writable allowlist. */
async function readLiveOf(ctx: Ctx, entry: RegistryEntry, draft: StoredDraft) {
  let q = ctx.sb
    .from(entry.table)
    .select(stagedSelect(entry, entry.key))
    .eq('tenant_id', ctx.auth.tenantId);
  if (entry.key === 'id') q = q.eq('id', draft.entity_id);
  const { data, error } = await q.maybeSingle();
  if (error) throw new Error(`read ${entry.table}: ${error.message}`);
  return (data as Row | null) ?? null;
}

const UNREADABLE = 'This change can no longer be read. Discard it.';

/**
 * Settle a pending change the live site moved under, column by column: "Keep mine" makes the
 * change start from what live holds now (`base[col] = live[col]`); "Use the live version"
 * stops it writing the column (the payload key that writes it is dropped whole; entity SEO, a
 * full replace, takes the live value instead). A change left writing nothing is thrown away.
 */
export async function resolveDraft(
  ctx: Ctx,
  id: string | undefined,
  input: ResolveRequest,
): Promise<Row | Response> {
  const { auth, sb, audit } = ctx;
  const draft = await loadDraftById(ctx, id);
  const type = draft.entity_type;
  const entry = RELEASE_REGISTRY[type];
  if (!mayRewrite(auth.role, draft)) {
    const caps = requiredCaps({
      entityType: type,
      op: draft.op,
      patch: { status: storedStatus(draft.payload) },
    });
    const missing = caps?.find((cap) => ROLE_CAPS[auth.role][cap] !== 'full');
    return refuse(missing ?? RELEASE_ENTITY_META[type].authorCaps[0]!, [draft.id]);
  }
  if (draft.release_id !== null) throw new DraftConflictError('scheduled', type);
  if (draft.version !== input.version) throw new DraftConflictError('draft-conflict', type);
  if (draft.op !== 'update') {
    throw new ValidationError(
      'Only a change to something already on the site can conflict with it.',
      'keepMine',
    );
  }
  // A change is rewritten only while releases are on (0062's RESTRICTIVE policy); with them
  // off it can only be thrown away (edge case 21), so say that rather than a bare 403.
  if (!(await ctx.releasesEnabled())) {
    throw new ValidationError('Publishing is switched off: this change can only be thrown away.');
  }

  const live = await readLiveOf(ctx, entry, draft);
  if (!live) {
    throw new DraftConflictError(
      'draft-conflict',
      type,
      null,
      'This item was removed on the live site. Discard the change.',
    );
  }
  let columns: string[];
  try {
    columns = Object.keys(derivePatch(entry, 'update', draft.payload).patch);
  } catch {
    throw new ValidationError(UNREADABLE);
  }
  const unknown = [...input.keepMine, ...input.useLive].filter((c) => !columns.includes(c));
  if (unknown.length > 0) {
    throw new ValidationError(`Not part of this change: ${unknown.join(', ')}`, 'keepMine');
  }

  const base: Row = { ...draft.base };
  for (const column of input.keepMine) base[column] = live[column] ?? null;
  const payload: Row = { ...draft.payload };
  if (entry.kind === 'entitySeo') {
    for (const column of input.useLive) {
      const key = SEO_KEY_OF[column];
      if (key) payload[key] = live[column] ?? null;
      base[column] = live[column] ?? null;
    }
  } else {
    const useLive = new Set(input.useLive);
    for (const [key, cols] of Object.entries(entry.fields)) {
      if (!(key in payload) || !cols.some((c) => useLive.has(c))) continue;
      delete payload[key];
      for (const c of cols) delete base[c];
    }
  }

  let next;
  try {
    next = derivePatch(entry, 'update', payload);
  } catch {
    throw new ValidationError(UNREADABLE);
  }
  const target = writeTarget(type);
  const { entityId, detail } = auditTarget(draft);
  const empty =
    entry.kind === 'entitySeo'
      ? dropNoOps(next.patch, live, base) === null
      : Object.keys(next.patch).length === 0 && Object.keys(next.children).length === 0;
  if (empty) {
    await writeDrafts(
      sb,
      auth,
      [
        {
          action: 'discard',
          draft_id: draft.id,
          expected_version: draft.version,
          entity_type: type,
          entity_id: draft.entity_id,
        },
      ],
      target,
    );
    audit({
      action: `${type}.draft_resolve`,
      entityType: type,
      entityId,
      detail: { keepMine: input.keepMine, useLive: input.useLive, discarded: true, ...detail },
    });
    return { resolved: draft.id, draft: null };
  }

  const label = DraftLabelSchema.safeParse(draft.label);
  const write: Extract<WriteDraftsOp, { action: 'put' }> = {
    action: 'put',
    entity_type: type,
    entity_id: draft.entity_id,
    op: 'update',
    payload,
    fields: draftFields(next),
    base: pick(base, Object.keys(next.patch)),
    base_version: draft.base_version ?? (live['version'] as number),
    label: label.success ? label.data : null,
    draft_id: draft.id,
    expected_version: draft.version,
  };
  const [written] = await writeDrafts(sb, auth, [write], target);
  const result = overlayRow(live, writtenDraft(write, written!, auth, draft), entry);
  audit({
    action: `${type}.draft_resolve`,
    entityType: type,
    entityId,
    detail: { keepMine: input.keepMine, useLive: input.useLive, ...detail },
  });
  return { ...(result.row ?? { [entry.key]: draft.entity_id }), draft: result.draft };
}
