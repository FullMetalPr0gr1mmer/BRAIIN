import { z } from 'zod';
import type { DraftOp } from '@schemas/release';
import {
  PagePasswordDraftSchema,
  PagePasswordWriteSchema,
  type PagePasswordWrite,
  type PageVisibilityWrite,
} from '@schemas/visibility';
import type { AdminRouteContext } from '@/lib/admin/route';
import { AuthorizationError } from '@/lib/authz/errors';
import { DraftConflictError, OptimisticLockError, ValidationError } from '@/lib/admin/errors';
import { syncVisibilityToEdge, visibilityPurgeTags } from '@/lib/admin/visibilitySync';
import { purgeAfterSave } from '@/lib/http/purge';
import {
  PAGE_VISIBILITY,
  VISIBILITY_ROW_COLUMNS,
  checkVisibilityWrite,
  listVisibilityWithRows,
  settingOfRow,
  type VisibilityPageItem,
  type VisibilityPending,
  type VisibilitySaveResult,
  type VisibilitySetting,
  type VisibilityTemplateItem,
} from '@/lib/admin/pageVisibility';
import { HOME_REFUSAL } from '@/lib/admin/visibilityCopy';
import {
  derivePatch,
  dropNoOps,
  mergePayload,
  overlayRow,
  recordBase,
  type DraftInput,
} from './overlay';
import { registryEntry } from './registry';
import {
  draftFields,
  draftWasPublished,
  loadDraftsOf,
  shouldAudit,
  writeDrafts,
  writtenDraft,
  type StoredDraft,
} from './drafts';
import { pick, put, stagedSelect } from './staged';
import { parseDraftSave } from './stagedSingleton';
import { STALE_MODE_DETAIL } from './releasesOff';

// The staged branch of page visibility (Admin v2 R14b; docs/admin-v2/releases.md §1.1, P-3).
// SERVER ONLY (it reaches the registry). `page_visibility` joined the release registry in U14a
// (0057) and is guarded by 0066 like every registry table, so with releases on a direct write
// is refused; until R14b its routes wrote it whatever the flag, and the screen could save
// nothing in release mode. With releases on for the caller's tenant the routes hand the request
// here; their legacy bodies stay as they are (R15 removes them).
//
// A setting is keyed by its target (a page, or a template), as entity SEO is keyed by its
// target, and a save is a full replace. So, as stagedEntitySeo.ts:
//   • the pending change of an existing row is keyed by the row's id; with no row yet it is a
//     pending create under a Worker-allocated id, found by the target its payload stores;
//   • the payload always stores the target, and an edit never moves it (rowPayload.ts);
//   • the save's own rules run at stage time (`checkVisibilityWrite`: the homepage stays
//     visible, a redirect goes to another page that renders), and again at publish
//     (validate.ts);
//   • a page or template with no row is visible to everyone, so a save of "visible to
//     everyone" there stages nothing (a pending create for it is thrown away).
// The edge's snapshot is not rebuilt here: nothing live moved. A publish rebuilds it (R7's
// after-effects), and the screen's "live site" line keeps comparing the LIVE settings.
//
// The password itself stays immediate (P-3: a secret; 0061 exempts `password_version`), and no
// release carries it. With releases on the password door (Admin v2 R14e, owner item B1 option b)
// stores the secret at once and stages the mode and the message like any other setting; the page
// asks for the password once that change is published (stagedPasswordWrite, below).

type Row = Record<string, unknown>;
type Ctx = AdminRouteContext<unknown>;
type Target = PageVisibilityWrite['target'];

const entry = () => registryEntry('page_visibility');
const TARGET = { entity: PAGE_VISIBILITY.entity, cap: PAGE_VISIBILITY.writeCap } as const;

/** Pending changes read for the listing: far above the pages a tenant lists (2,000 at most). */
export const VISIBILITY_DRAFT_CAP = 1000;

/** A target as a map key: `page:<id>` or `template:<name>`. */
export function targetKey(target: unknown): string | null {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return null;
  const t = target as Row;
  if (typeof t['pageId'] === 'string') return `page:${t['pageId']}`;
  if (typeof t['template'] === 'string') return `template:${t['template']}`;
  return null;
}

/** A live row's target key. */
function rowKey(row: Row): string | null {
  if (typeof row['page_id'] === 'string') return `page:${row['page_id']}`;
  if (typeof row['template'] === 'string') return `template:${row['template']}`;
  return null;
}

/**
 * The live row with its days as instants in one spelling, so saving the stored day back is not a
 * change (PostgREST spells a timestamptz `…+00:00`, the save `…Z`).
 */
function inOneSpelling(row: Row): Row {
  const out: Row = { ...row };
  for (const column of ['hide_from', 'show_on']) {
    const value = out[column];
    if (typeof value !== 'string') continue;
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) out[column] = new Date(ms).toISOString();
  }
  return out;
}

/** The pending change as the screen reads it: the setting it leaves, and the change to name. */
function pendingOf(live: Row | null, draft: DraftInput): VisibilityPending {
  const ref = {
    draftId: draft.id,
    draftVersion: draft.version,
    entityId: draft.entity_id,
    op: draft.op,
    scheduled: draft.release_id !== null,
  };
  try {
    const { row, draft: meta } = overlayRow(live && inOneSpelling(live), draft, entry());
    const setting: VisibilitySetting | null = row ? settingOfRow(row) : null;
    return { ...ref, setting, conflict: meta.conflict ?? [] };
  } catch {
    // A stored change that no longer parses: the live setting stands; R6's dry run reports it.
    return { ...ref, setting: null, conflict: [] };
  }
}

/** The pending changes of the tenant's settings, by the row's id and, for creates, by target. */
function indexDrafts(drafts: readonly StoredDraft[]) {
  const byRow = new Map<string, StoredDraft>();
  const creates = new Map<string, StoredDraft>();
  for (const draft of drafts) {
    if (draft.op === 'create') {
      const key = targetKey((draft.payload as Row)['target']);
      if (key && !creates.has(key)) creates.set(key, draft);
    } else {
      byRow.set(draft.entity_id, draft);
    }
  }
  return { byRow, creates };
}

/** GET: the listing as live, each page and template with its pending change. */
export async function stagedVisibilityList(ctx: Ctx): Promise<{
  pages: VisibilityPageItem[];
  templates: VisibilityTemplateItem[];
  draftsInvalid: string[];
}> {
  const { sb, auth } = ctx;
  const [{ list, rows }, loaded] = await Promise.all([
    listVisibilityWithRows(sb, auth),
    loadDraftsOf(sb, auth, 'page_visibility', { limit: VISIBILITY_DRAFT_CAP }),
  ]);
  const { byRow, creates } = indexDrafts(loaded.drafts);
  const live = new Map<string, Row>();
  for (const row of rows) {
    const key = rowKey(row);
    if (key) live.set(key, row);
  }
  const pending = (key: string): VisibilityPending | null => {
    const row = live.get(key) ?? null;
    const draft = row ? (byRow.get(String(row['id'])) ?? null) : (creates.get(key) ?? null);
    return draft ? pendingOf(row, draft) : null;
  };
  return {
    pages: list.pages.map((page) => ({ ...page, pending: pending(`page:${page.id}`) })),
    templates: list.templates.map((template) => ({
      ...template,
      pending: pending(`template:${template.template}`),
    })),
    draftsInvalid: loaded.invalid,
  };
}

/** The live row of a target, every allowlisted column. */
async function readLive(ctx: Ctx, target: Target): Promise<Row | null> {
  const { data, error } = await ctx.sb
    .from(PAGE_VISIBILITY.table)
    .select(stagedSelect(entry(), VISIBILITY_ROW_COLUMNS))
    .eq('tenant_id', ctx.auth.tenantId)
    .match(PAGE_VISIBILITY.target({ target }))
    .maybeSingle();
  if (error) throw new Error(`read page_visibility: ${error.message}`);
  return (data as Row | null) ?? null;
}

/** The pending change of a target: by its row's id, or the pending create naming it. */
async function loadVisibilityDraft(
  ctx: Ctx,
  live: Row | null,
  target: Target,
): Promise<StoredDraft | null> {
  const { drafts } = await loadDraftsOf(ctx.sb, ctx.auth, 'page_visibility', {
    limit: VISIBILITY_DRAFT_CAP,
    ...(live ? { entityIds: [String(live['id'])] } : {}),
  });
  if (live) return drafts.find((d) => d.entity_id === String(live['id'])) ?? null;
  return indexDrafts(drafts).creates.get(targetKey(target) ?? '') ?? null;
}

/** What a staged save answers: the live setting, its pending change, nothing for the edge. */
export interface StagedVisibilityAnswer {
  setting: VisibilitySetting | null;
  pending: VisibilityPending | null;
  /** Nothing live moved, so the edge has nothing to take. */
  kvSynced: true;
  purgeTags: string[];
  staged: true;
}

const answer = (live: Row | null, pending: VisibilityPending | null): StagedVisibilityAnswer => ({
  setting: live ? settingOfRow(live) : null,
  pending,
  kvSynced: true,
  purgeTags: [],
  staged: true,
});

/** Where the audit row points: the page, or the template's own setting. */
function auditTarget(target: VisibilitySaveResult['target'], entityId: string) {
  return target.kind === 'page'
    ? { entityType: 'page', entityId: target.id, detail: { page: target.slug } }
    : { entityType: 'page_visibility', entityId, detail: { template: target.template } };
}

/**
 * PUT: the save becomes the target's pending change (a full replace). The body is the screen's
 * (PageVisibilityWriteSchema) plus the change it names (`draftId` + `draftVersion`) and the
 * release-mode marker.
 */
export async function stagedVisibilityWrite(
  ctx: Ctx,
  raw: unknown,
): Promise<StagedVisibilityAnswer> {
  const { payload, ref } = parseDraftSave<PageVisibilityWrite>(PAGE_VISIBILITY.WriteSchema, raw);
  const target = await checkVisibilityWrite(ctx.sb, ctx.auth, payload);
  const live = await readLive(ctx, payload.target);
  const draft = await loadVisibilityDraft(ctx, live, payload.target);
  await assertNamed(ctx, live, draft, ref, payload.version);
  // A full replace: the save alone, its target always kept.
  const stored = mergePayload(null, payload, entry());
  return answer(live, await stageSetting(ctx, target, live, draft, stored));
}

/**
 * The pending change a save must name, as every staged editor names it: a change held by a
 * scheduled release cannot move; a pending change must be the one the screen read; a change the
 * screen names that is gone was published or discarded; with none, the live version is checked.
 */
async function assertNamed(
  ctx: Ctx,
  live: Row | null,
  draft: StoredDraft | null,
  ref: { draftId: string; draftVersion: number } | null,
  version: number,
): Promise<void> {
  if (draft) {
    if (draft.release_id !== null)
      throw new DraftConflictError('scheduled', PAGE_VISIBILITY.entity);
    if (!ref || ref.draftId !== draft.id || ref.draftVersion !== draft.version) {
      throw new DraftConflictError('draft-conflict', PAGE_VISIBILITY.entity);
    }
  } else if (ref) {
    const published = await draftWasPublished(ctx.sb, ctx.auth, ref.draftId);
    throw new DraftConflictError(
      published ? 'draft-published' : 'draft-discarded',
      PAGE_VISIBILITY.entity,
      live,
    );
  } else if ((live ? live['version'] : 0) !== version) {
    // The legacy save's rule: the version the drawer read (0 while there is no row).
    throw new OptimisticLockError(PAGE_VISIBILITY.table);
  }
}

/**
 * Stages one setting as its target's full replace, `stored` being the payload as the draft keeps
 * it: no row and "visible to everyone", or a change equal to live, stages nothing (and discards a
 * pending change it replaces); otherwise the pending change is written and audited (the mode and
 * field names only). Returns the pending change, or null when nothing is pending.
 */
async function stageSetting(
  ctx: Ctx,
  target: VisibilitySaveResult['target'],
  live: Row | null,
  draft: StoredDraft | null,
  stored: Row,
): Promise<VisibilityPending | null> {
  const { sb, auth, audit } = ctx;
  const e = entry();
  const op: DraftOp = live ? 'update' : 'create';
  const discard = async (reason: string) => {
    if (!draft) return;
    await writeDrafts(
      sb,
      auth,
      [{ action: 'discard', draft_id: draft.id, expected_version: draft.version }],
      TARGET,
    );
    const at = auditTarget(target, draft.entity_id);
    audit({
      action: 'page_visibility.draft_discard',
      entityType: at.entityType,
      entityId: at.entityId,
      detail: { op: draft.op, reason, ...at.detail },
    });
  };

  if (op === 'create' && stored['mode'] === 'public') {
    // No row is "visible to everyone": nothing to publish.
    await discard('no-op');
    return null;
  }
  const derived = derivePatch(e, op, stored);
  let changed = derived.patch;
  const liveNow = live ? inOneSpelling(live) : null;
  if (op === 'update') {
    const remaining = dropNoOps(e.entityType, derived.patch, liveNow!, draft?.base);
    if (!remaining) {
      // The save equals live: nothing is pending.
      await discard('no-op');
      return null;
    }
    changed = remaining;
  }

  const entityId = live ? String(live['id']) : (draft?.entity_id ?? crypto.randomUUID());
  const base =
    op === 'create'
      ? {}
      : pick(recordBase(draft?.base, liveNow, derived.patch), Object.keys(derived.patch));
  const baseVersion =
    op === 'create' ? null : (draft?.base_version ?? (live!['version'] as number));
  const labelRow = { ...(live ?? {}), ...derived.patch };
  const write = {
    ...put(e, entityId, op, stored, derived, base, baseVersion, labelRow, draft),
    fields: draftFields({ patch: changed, children: {}, exempt: {} }),
  };
  const [written] = await writeDrafts(sb, auth, [write], TARGET);
  const saved = writtenDraft(write, written!, auth, draft);
  if (shouldAudit(draft, auth, op)) {
    const at = auditTarget(target, entityId);
    audit({
      action: 'page_visibility.draft_save',
      entityType: at.entityType,
      entityId: at.entityId,
      detail: { op, mode: stored['mode'], fields: write.fields, ...at.detail },
    });
  }
  return pendingOf(live, saved);
}

// ---- the password door with releases on (Admin v2 R14e, owner item B1 option b) --------------

/** What `public.store_page_password` answers: whether the live gate took the new password. */
const StoredAnswerSchema = z.object({
  live: z.boolean(),
  passwordVersion: z.number().int().nullable(),
});

/** What the door answers with releases on: a staged answer that may have reached the edge. */
export interface StagedPasswordAnswer extends Omit<StagedVisibilityAnswer, 'kvSynced'> {
  kvSynced: boolean;
  /** The page asked for a password on the live site, and asks for the new one now. */
  passwordLive: boolean;
}

/**
 * POST /api/admin/page-visibility/password with releases on, after the route's live recheck. A
 * secret is immediate and no release carries one (P-3), so the door splits the change in two:
 *   1. the secret, at once: `public.store_page_password` (a definer: the live profile, its own
 *      tenant, releases on) stores its bcrypt hash and nothing else, but for the exempt
 *      `password_version` of a page that already asks for a password live, which then asks for
 *      the new one (every unlock cookie of the old one stops verifying);
 *   2. the mode and the message, staged as the page's visibility change (a full replace), which
 *      put the page behind the stored password when it is published. Until then the hash is
 *      inert: `page_password_check` admits no one to a page whose live mode is not password.
 * The checks of a staged save come first (the page, the homepage, the change named, a scheduled
 * one refused, the live version), so a refused request stores nothing. The password goes from the
 * body to the database and nowhere else: not into the draft (`PagePasswordDraftSchema` has no key
 * for it), the audit row, the answer or a log.
 */
export async function stagedPasswordWrite(ctx: Ctx, raw: unknown): Promise<StagedPasswordAnswer> {
  const { sb, auth } = ctx;
  const { payload: input, ref } = parseDraftSave<PagePasswordWrite>(PagePasswordWriteSchema, raw);
  const pageTarget = { pageId: input.pageId };
  // The save's own rules: the page is this tenant's, and the homepage stays visible (the rule
  // reads only "not public"; a password page has no redirect or days).
  const target = await checkVisibilityWrite(sb, auth, {
    target: pageTarget,
    mode: 'hidden',
    redirectPageId: null,
    hideFrom: null,
    showOn: null,
    version: input.version,
  });
  const before = await readLive(ctx, pageTarget);
  const draft = await loadVisibilityDraft(ctx, before, pageTarget);
  await assertNamed(ctx, before, draft, ref, input.version);

  // 1. The secret, at once.
  const { data, error } = await sb.rpc('store_page_password', {
    p_page_id: input.pageId,
    p_password: input.password,
  });
  if (error) {
    // 42501 is the function's own live check (a demoted token), 22023 its argument checks,
    // 55000 releases switched off since the flag was read, 23514 the homepage.
    if (error.code === '42501') throw new AuthorizationError('maintenance.manage', 'live check');
    if (error.code === '22023') {
      throw new ValidationError('That password is too short or too long.', 'password');
    }
    if (error.code === '55000') {
      throw new DraftConflictError('releases-off', PAGE_VISIBILITY.entity, null, STALE_MODE_DETAIL);
    }
    if (error.code === '23514') throw new ValidationError(HOME_REFUSAL, 'mode');
    throw new Error(`store_page_password failed (${error.code ?? 'no code'})`);
  }
  const stored = StoredAnswerSchema.parse(data);

  // 2. The mode and the message, staged against the row as it is now (its version moved where
  //    the live gate took the password).
  const live = stored.live ? await readLive(ctx, pageTarget) : before;
  const { version: _version, ...change } = PagePasswordDraftSchema.parse({
    target: pageTarget,
    mode: 'password',
    note: input.note,
    version: 0,
  });
  const pending = await stageSetting(ctx, target, live, draft, change);

  // 3. The edge, only where the live gate moved: its snapshot carries the version every unlock
  //    cookie is signed over. A page newly behind a password changes nothing live yet.
  let kvSynced = true;
  let purgeTags: string[] = [];
  if (stored.live && target.kind === 'page') {
    kvSynced = (await syncVisibilityToEdge(sb, auth)).kvSynced;
    purgeTags = visibilityPurgeTags({ kind: 'page', slug: target.slug });
    await purgeAfterSave(auth.tenantId, purgeTags, 'visibility');
  }
  return {
    setting: live ? settingOfRow(live) : null,
    pending,
    kvSynced,
    purgeTags,
    staged: true,
    passwordLive: stored.live,
  };
}
