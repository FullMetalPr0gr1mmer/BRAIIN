import { expect, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { TENANT_ID } from '../../scripts/gen-seeds.mjs';
import { savedWords } from '@/components/admin/kit/saveWords';
import { releasesOn, staffEnv } from './staff';

/*
 * The steps the admin specs written for releases off take to run in both modes (Admin v2 R14b;
 * R14a's conversion plan). With releases off every helper here is either a no-op or returns
 * exactly what the spec sent before, so the releases-off job runs what it ran. With releases on
 * (E2E_RELEASES=on: the required e2e job since R14c):
 *
 *   - a direct save names the pending change its row carries (`draftId` + `draftVersion`) and
 *     says it was made in release mode (`staged: true`), or names the live version when nothing
 *     is pending (`withDraft`);
 *   - a spec publishes ONLY its own pending changes, read from GET /api/admin/releases/pending
 *     and sent to POST /api/admin/releases (`publishOwn`), never "everything ticked";
 *   - before it restores a row, a spec throws its own unclaimed pending changes away as the
 *     system (the service role, `discardDrafts`), so none is left for a later spec's savebar;
 *   - copy that differs by mode comes from the function that writes it (`savedPattern`).
 */

type Row = Record<string, unknown>;

/** The local stack's service role (never a hosted one: staffEnv refuses anything else). */
export function systemClient() {
  const env = staffEnv()!;
  return createClient(env.url, env.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** The CSRF token the admin layout carries, and the origin a write sends with it. */
export async function writeHeaders(page: Page): Promise<Record<string, string>> {
  if (!page.url().includes('/admin')) await page.goto('/admin', { waitUntil: 'networkidle' });
  const token = await page.locator('meta[name="csrf-token"]').getAttribute('content');
  expect(token, 'the admin layout carries a CSRF token').toBeTruthy();
  return { 'x-csrf-token': token!, origin: new URL(page.url()).origin };
}

/**
 * A direct save's body in the current mode. Releases off: `values` with the row's version,
 * exactly as before. Releases on: the pending change the row carries is named (its version
 * stands in for the row's), or with none the live version, and the release-mode marker.
 */
export function withDraft(row: Row, values: Row): Row {
  const version = row['version'];
  if (!releasesOn()) return { ...values, version };
  const draft = row['draft'];
  if (draft && typeof draft === 'object' && !Array.isArray(draft)) {
    const d = draft as Row;
    return { ...values, version, draftId: d['id'], draftVersion: d['version'], staged: true };
  }
  return { ...values, version, staged: true };
}

/** What a spec's own pending changes are: an entity type, and the ids it made (all if none). */
export interface Own {
  entityType: string;
  entityIds?: readonly string[];
}

export interface PendingItem {
  draftId: string;
  draftVersion: number;
  entityType: string;
  entityId: string;
  scheduled: boolean;
}

/** The unscheduled pending changes matching `own`, as the person may read them. */
export async function pendingOf(page: Page, own: readonly Own[]): Promise<PendingItem[]> {
  const res = await page.request.get('/api/admin/releases/pending');
  expect(res.status(), await res.text()).toBe(200);
  const body = (await res.json()) as { data?: { items?: PendingItem[] }; items?: PendingItem[] };
  return (body.data?.items ?? body.items ?? []).filter(
    (item) =>
      !item.scheduled &&
      own.some(
        (o) =>
          o.entityType === item.entityType &&
          (o.entityIds === undefined || o.entityIds.includes(item.entityId)),
      ),
  );
}

/**
 * The matching pending changes once they hold still: an editor in release mode may still be
 * saving (a blur's save, then the button's), so the list is read until two reads 750 ms apart
 * name the same changes at the same versions (at most about 15 s), and a publish never names a
 * version that moves under it (409 `pending-changed`).
 */
async function settledPending(page: Page, own: readonly Own[]): Promise<PendingItem[]> {
  const key = (items: readonly PendingItem[]) =>
    items
      .map((i) => `${i.draftId}:${i.draftVersion}`)
      .sort()
      .join(',');
  let items = await pendingOf(page, own);
  for (let round = 0; round < 20; round += 1) {
    await page.waitForTimeout(750);
    const again = await pendingOf(page, own);
    if (key(again) === key(items)) return again;
    items = again;
  }
  return items;
}

/**
 * Releases on: publishes exactly the spec's own pending changes (at least `atLeast`) and
 * answers the version they went live as. Releases off: nothing to publish (a save was live),
 * null. The publish is the route the dialog calls; the dialog itself is driven by
 * tests/admin/releases-mode.e2e.ts and releases-ui.e2e.ts.
 */
export async function publishOwn(
  page: Page,
  own: readonly Own[],
  atLeast = 1,
): Promise<number | null> {
  if (!releasesOn()) return null;
  const items = await settledPending(page, own);
  expect(items.length, `pending changes of ${JSON.stringify(own)}`).toBeGreaterThanOrEqual(atLeast);
  if (items.length === 0) return null;
  const res = await page.request.post('/api/admin/releases', {
    headers: await writeHeaders(page),
    data: { items: items.map(({ draftId, draftVersion }) => ({ draftId, draftVersion })) },
  });
  expect(res.status(), await res.text()).toBe(200);
  const body = (await res.json()) as {
    data?: { release: { number: number } };
    release?: { number: number };
  };
  const number = (body.data ?? body).release?.number;
  expect(number, 'the publish names its version').toBeGreaterThan(0);
  return number!;
}

/**
 * Releases on: throws the unclaimed pending changes matching `own` away as the system (the
 * draft table is the service role's to clean; a claimed one belongs to a scheduled release and
 * is left). Releases off: nothing can be pending, nothing to do.
 */
export async function discardDrafts(own: readonly Own[]): Promise<void> {
  if (!releasesOn()) return;
  const svc = systemClient();
  for (const o of own) {
    let q = svc
      .from('content_drafts')
      .delete()
      .eq('tenant_id', TENANT_ID)
      .eq('entity_type', o.entityType)
      .is('release_id', null);
    if (o.entityIds !== undefined) {
      if (o.entityIds.length === 0) continue;
      q = q.in('entity_id', [...o.entityIds]);
    }
    const { error } = await q;
    expect(error, `discard ${o.entityType}`).toBeNull();
  }
}

/** Whether a pending change matching `own` exists (any author, claimed or not). */
export async function hasDrafts(own: Own): Promise<boolean> {
  let q = systemClient()
    .from('content_drafts')
    .select('id')
    .eq('tenant_id', TENANT_ID)
    .eq('entity_type', own.entityType);
  if (own.entityIds !== undefined) q = q.in('entity_id', [...own.entityIds]);
  const { data, error } = await q;
  expect(error).toBeNull();
  return (data ?? []).length > 0;
}

/**
 * "Saved at 14:05" (releases off) or "Saved as an unpublished change at 14:05" (releases on),
 * from SaveStatus's own words.
 */
export function savedPattern(): RegExp {
  return new RegExp(`${savedWords(releasesOn())} at \\d\\d:\\d\\d`);
}

/**
 * Releases on: throws away the unclaimed pending changes of `entityType` whose stored payload
 * matches `pattern` at `path` (a PostgREST JSON path into the camelCase payload, such as
 * `payload->question->>en`), as the system. For a spec's pending creates whose ids it may not
 * have read yet when a step fails: its marker finds them. Releases off: nothing to do.
 */
export async function discardDraftsLike(
  entityType: string,
  path: string,
  pattern: string,
): Promise<void> {
  if (!releasesOn()) return;
  const { error } = await systemClient()
    .from('content_drafts')
    .delete()
    .eq('tenant_id', TENANT_ID)
    .eq('entity_type', entityType)
    .is('release_id', null)
    .like(path, pattern);
  expect(error, `discard ${entityType} like ${pattern}`).toBeNull();
}

/**
 * The ids a list's reorder named (its POST body's `items`), in both modes: what a move staged
 * with releases on, so the spec publishes exactly those (never "everything pending").
 */
export function reorderedIds(postData: string | null): string[] {
  const body = JSON.parse(postData ?? '{}') as { items?: { id?: unknown }[] };
  const ids = (body.items ?? []).map((item) => item.id).filter((id) => typeof id === 'string');
  expect(ids.length, 'the reorder named the rows it moved').toBeGreaterThan(0);
  return ids as string[];
}

/**
 * Releases on: asks to publish the spec's own pending changes and answers what the route said,
 * for a step that expects the publish to be refused (a rule that release mode checks when the
 * change goes live, not when it is saved). Releases off: null (a save was live and checked).
 */
export async function tryPublishOwn(
  page: Page,
  own: readonly Own[],
): Promise<{ status: number; text: string } | null> {
  if (!releasesOn()) return null;
  const items = await settledPending(page, own);
  expect(items.length, `pending changes of ${JSON.stringify(own)}`).toBeGreaterThan(0);
  const res = await page.request.post('/api/admin/releases', {
    headers: await writeHeaders(page),
    data: { items: items.map(({ draftId, draftVersion }) => ({ draftId, draftVersion })) },
  });
  return { status: res.status(), text: await res.text() };
}
