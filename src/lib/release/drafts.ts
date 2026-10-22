import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { AuthContext } from '@/lib/auth/types';
import type { Capability } from '@/lib/authz/matrix';
import { AuthorizationError } from '@/lib/authz/errors';
import { DraftConflictError, ValidationError } from '@/lib/admin/errors';
import {
  ContentDraftRowSchema,
  DRAFT_FIELD_NAME,
  DRAFT_FIELDS_MAX,
  DRAFT_LABEL_TEXT_MAX,
  DraftConflictDetailSchema,
  DraftLabelSchema,
  WriteDraftsOpsSchema,
  WriteDraftsResultSchema,
  type DraftLabel,
  type DraftOp,
  type WriteDraftsOp,
  type WriteDraftsResult,
} from '@schemas/release';
import type { DerivedPatch, DraftInput } from './overlay';
import type { RegistryEntry } from './registry';

// Reading and writing the pending changes of one entity type (Admin v2 R3a). SERVER ONLY.
//
// Every draft write goes through `public.write_drafts` (migration 0062): SECURITY INVOKER, so
// RLS, the RESTRICTIVE live/flag/key policies and the draft lock bind as for a direct write,
// and a save's changes (a 200-row reorder included) are one transaction and one subrequest.
// The Worker checks the same caps first (payload, base, label, fields, op count), so an editor
// is told in words before the database refuses in a SQLSTATE.

type Row = Record<string, unknown>;
type Payload = Record<string, unknown>;

/** What a staged handler reads of a draft. */
export const DRAFT_COLUMNS =
  'id,entity_type,entity_id,op,payload,base,base_version,fields,label,version,created_at,updated_at,updated_by,release_id,origin_kind';

const StoredDraftSchema = ContentDraftRowSchema.pick({
  id: true,
  entity_type: true,
  entity_id: true,
  op: true,
  payload: true,
  base: true,
  base_version: true,
  fields: true,
  label: true,
  version: true,
  created_at: true,
  updated_at: true,
  updated_by: true,
  release_id: true,
}).extend({
  // A restore's change (R10, 0062's provenance): only the restore path's mark sets it. A reader
  // that does not select it (an older stand-in) reads an ordinary change.
  origin_kind: ContentDraftRowSchema.shape.origin_kind.default(null),
});
export type StoredDraft = z.infer<typeof StoredDraftSchema>;

/**
 * The version a restore's change holds until someone edits it (R10): the restore's own write
 * (1), then its mark (2, the draft lock bumps every update). The mark lands only on a draft
 * still at 1 with no provenance, so a restore's change at 2 is exactly as the restore left it.
 */
export const RESTORE_MARKED_VERSION = 2;

/** A restore's change that no one has edited since the restore staged it. */
export function untouchedRestore(draft: Pick<StoredDraft, 'origin_kind' | 'version'>): boolean {
  return draft.origin_kind === 'restore' && draft.version === RESTORE_MARKED_VERSION;
}

/** The most drafts of one entity type a list overlays (decision D14, edge case 17). */
export const DRAFT_LIST_CAP = 1000;

/** Coalescing (P-5, D9): one `draft_save` audit row per draft per person per ten minutes. */
export const DRAFT_AUDIT_WINDOW_MS = 10 * 60 * 1000;

/** One stored draft as read, or a 500 when the row is not one. */
export function parseDraft(row: unknown): StoredDraft {
  const parsed = StoredDraftSchema.safeParse(row);
  if (!parsed.success) throw new Error('content_drafts returned a row of the wrong shape');
  return parsed.data;
}

/** The pending change on one entity, or null. */
export async function loadDraft(
  sb: SupabaseClient,
  auth: AuthContext,
  entityType: string,
  entityId: string,
): Promise<StoredDraft | null> {
  const { data, error } = await sb
    .from('content_drafts')
    .select(DRAFT_COLUMNS)
    .eq('tenant_id', auth.tenantId)
    .eq('entity_type', entityType)
    .eq('entity_id', entityId)
    .maybeSingle();
  if (error) throw new Error(`load draft: ${error.message}`);
  return data ? parseDraft(data) : null;
}

/**
 * The pending changes of one entity type, newest first: at most `limit`, `truncated` when more
 * exist. A row that does not read as a draft is left out and its id reported (`invalid`).
 */
export async function loadDraftsOf(
  sb: SupabaseClient,
  auth: AuthContext,
  entityType: string,
  options: { limit?: number; entityIds?: readonly string[] } = {},
): Promise<{ drafts: StoredDraft[]; truncated: boolean; invalid: string[] }> {
  const limit = options.limit ?? DRAFT_LIST_CAP;
  let q = sb
    .from('content_drafts')
    .select(DRAFT_COLUMNS)
    .eq('tenant_id', auth.tenantId)
    .eq('entity_type', entityType);
  if (options.entityIds) q = q.in('entity_id', [...options.entityIds]);
  const { data, error } = await q.order('updated_at', { ascending: false }).limit(limit + 1);
  if (error) throw new Error(`load drafts: ${error.message}`);
  const rows = (data ?? []) as unknown[];
  const drafts: StoredDraft[] = [];
  const invalid: string[] = [];
  for (const row of rows.slice(0, limit)) {
    const parsed = StoredDraftSchema.safeParse(row);
    if (parsed.success) drafts.push(parsed.data);
    else invalid.push(String((row as Row | null)?.['id'] ?? 'unknown'));
  }
  return { drafts, truncated: rows.length > limit, invalid };
}

/** Did a release consume this draft (a `content_release_items` row names it)? Staff read items. */
export async function draftWasPublished(
  sb: SupabaseClient,
  auth: AuthContext,
  draftId: string,
): Promise<boolean> {
  const { data, error } = await sb
    .from('content_release_items')
    .select('id')
    .eq('tenant_id', auth.tenantId)
    .eq('draft_id', draftId)
    .limit(1);
  if (error) throw new Error(`release items: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}

/** Who is answerable for a refusal: the entity's name for a 409, its stage cap for a 403. */
export interface DraftWriteTarget {
  entity: string;
  cap: Capability;
}

/**
 * One call of the draft writer: the changes, checked against the database's caps first, then
 * `public.write_drafts` for the caller's own tenant. BR409 → DraftConflictError (its code);
 * 23514 → 422; 42501 → 403 (RLS refused it: with the Worker's own check first, a stale token
 * or releases switched off mid-request); anything else → a 500.
 */
export async function writeDrafts(
  sb: SupabaseClient,
  auth: AuthContext,
  ops: readonly WriteDraftsOp[],
  target: DraftWriteTarget,
): Promise<WriteDraftsResult> {
  const checked = WriteDraftsOpsSchema.safeParse(ops);
  if (!checked.success) {
    const tooLarge = checked.error.issues.some((i) => i.message === 'too-large');
    throw new ValidationError(
      tooLarge ? 'This change is too large to save. Shorten it and try again.' : 'invalid change',
    );
  }
  const { data, error } = await sb.rpc('write_drafts', {
    p_tenant: auth.tenantId,
    p_ops: checked.data,
  });
  if (error) {
    if (error.code === 'BR409') {
      const detail = DraftConflictDetailSchema.safeParse(safeJson(error.details));
      throw new DraftConflictError(
        detail.success ? detail.data.code : 'draft-conflict',
        target.entity,
      );
    }
    if (error.code === '23514') {
      throw new ValidationError('This change is too large to save. Shorten it and try again.');
    }
    if (error.code === '42501') {
      throw new AuthorizationError(target.cap, 'RLS refused a draft write');
    }
    throw new Error(`write_drafts: ${error.message}`);
  }
  const result = WriteDraftsResultSchema.safeParse(data);
  if (!result.success) throw new Error('write_drafts answered in the wrong shape');
  return result.data;
}

function safeJson(text: unknown): unknown {
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The payload without the keys whose columns all left the patch (a key with no column, a child
 * set, stays). A save that sets a field back to its live value then leaves nothing behind for
 * the publish to write, and nothing whose base was never recorded.
 */
export function dropFields(
  entry: RegistryEntry,
  payload: Readonly<Payload>,
  columns: Iterable<string>,
): Payload {
  const kept = new Set(columns);
  const out: Payload = {};
  for (const [key, value] of Object.entries(payload)) {
    const cols = entry.fields[key];
    if (
      entry.childKeys.includes(key) ||
      !cols ||
      cols.length === 0 ||
      cols.some((c) => kept.has(c))
    ) {
      out[key] = value;
    }
  }
  return out;
}

const clip = (text: string): string =>
  text.length > DRAFT_LABEL_TEXT_MAX ? text.slice(0, DRAFT_LABEL_TEXT_MAX) : text;

/** A list's label for the change (the registry's words for the row), within the label caps. */
export function draftLabel(entry: RegistryEntry, row: Readonly<Row>): DraftLabel | null {
  const label = entry.label({ ...row });
  const out: DraftLabel = { en: clip(label.en) };
  if (label.ar) out.ar = clip(label.ar);
  const parsed = DraftLabelSchema.safeParse(out);
  return parsed.success ? parsed.data : null;
}

/** The columns (and child sets) a change writes, for display: at most 200 names. */
export function draftFields(derived: DerivedPatch): string[] {
  return [...Object.keys(derived.patch), ...Object.keys(derived.children)]
    .filter((name) => DRAFT_FIELD_NAME.test(name))
    .slice(0, DRAFT_FIELDS_MAX);
}

/**
 * Write a `draft_save` audit row for this save? Not when it amends a draft this person last
 * wrote less than ten minutes ago with the same op (P-5): an editor saving every few seconds
 * is one entry. Read from the draft row itself (no audit_log read: Content Creator cannot).
 * A restore's change as the restore left it was audited as the restore (`versions.restore`,
 * naming the version, not the entity), though it names the person who restored it (0104): the
 * first save on top of it is this entity's first `draft_save`.
 */
export function shouldAudit(
  previous: Pick<
    StoredDraft,
    'updated_by' | 'updated_at' | 'op' | 'origin_kind' | 'version'
  > | null,
  auth: AuthContext,
  op: DraftOp,
  now: number = Date.now(),
): boolean {
  if (!previous) return true;
  if (untouchedRestore(previous)) return true;
  if (previous.updated_by !== auth.userId || previous.op !== op) return true;
  const at = Date.parse(previous.updated_at);
  return !Number.isFinite(at) || now - at >= DRAFT_AUDIT_WINDOW_MS;
}

/** The draft as just written, for the overlay that answers the save. */
export function writtenDraft(
  op: Extract<WriteDraftsOp, { action: 'put' }>,
  result: WriteDraftsResult[number],
  auth: AuthContext,
  previous: StoredDraft | null,
): DraftInput {
  const now = new Date().toISOString();
  return {
    id: result.draft_id,
    entity_type: op.entity_type,
    entity_id: op.entity_id,
    op: op.op,
    payload: op.payload,
    base: op.base,
    version: result.version ?? 1,
    created_at: previous?.created_at ?? now,
    updated_at: now,
    updated_by: auth.userId,
    release_id: null,
  };
}
