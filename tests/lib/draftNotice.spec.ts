import { describe, expect, it, vi } from 'vitest';
import { settleConflict, type ResolvePost } from '@/components/admin/fields/DraftNotice';
import {
  buildSaveRequest,
  entitySaveReducer,
  initialSaveState,
  type EntitySaveState,
  type SaveTarget,
} from '@/lib/admin/entitySave';
import { portfolioResource } from '@/lib/admin/resources';
import { uiFor } from '@/lib/admin/uiSchema';
import { overlayRow } from '@/lib/release/overlay';
import { RELEASE_REGISTRY } from '@/lib/release/registry';

// Settling a conflict from an editor's head (Admin v2 R12, DraftNotice; pre-merge review).
// The resolve endpoint answers the live row with the change laid over it, read over the
// registry's columns only: a case study's services and media are embeds only the item GET
// reads, so that answer has neither. Adopted as the form, both showed empty and the next
// autosave staged a change that removes every service and media item at publish. The editor
// now reads its record again through its own GET after every settle.

type Row = Record<string, unknown>;

const ID = '33333333-3333-4333-8333-333333333301';
const D = '77777777-7777-4777-8777-000000000001';
const SVC_A = '44444444-4444-4444-8444-000000000001';
const SVC_B = '44444444-4444-4444-8444-000000000002';
const POSTER = '55555555-5555-4555-8555-000000000001';

const fields = uiFor('portfolio').fields;
const target: SaveTarget = { kind: 'resource', slug: 'portfolio' };

/** The project's live columns, as the resolve reads them (no embeds). */
const LIVE: Row = {
  id: ID,
  slug: 'atlas',
  title: { en: 'Atlas live', ar: 'أطلس' },
  status: 'published',
  version: 3,
  year: 2024,
};
/** The embeds only the item GET selects (portfolioResource.columns). */
const EMBEDS: Row = {
  portfolio_services: [
    { service_id: SVC_B, sort_order: 2 },
    { service_id: SVC_A, sort_order: 1 },
  ],
  portfolio_media: [
    {
      role: 'hero',
      kind: 'image',
      media_id: POSTER,
      video_uid: null,
      video_path: null,
      clip_start_s: null,
      clip_end_s: null,
      duration_label: null,
      caption: null,
      breakdown_kind: null,
      layout: null,
      sort_order: 1,
    },
  ],
};

const stored = (version: number, conflict: boolean) => ({
  id: D,
  tenant_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  entity_type: 'portfolio' as const,
  entity_id: ID,
  op: 'update' as const,
  payload: { title: { en: 'Atlas mine', ar: 'أطلسي' } },
  fields: ['title'],
  // A base live no longer equals is the conflict; after Keep mine the base is live's.
  base: { title: conflict ? { en: 'Atlas then', ar: 'أطلس' } : LIVE['title'] },
  base_version: 3,
  label: null,
  version,
  created_at: '2026-10-20T08:00:00Z',
  updated_at: '2026-10-20T08:00:00Z',
  created_by: null,
  updated_by: null,
  release_id: null,
});

/** What the editor's item GET answers (stagedRead: live with its embeds, the change over it). */
function itemGet(version: number, conflict: boolean): Row {
  const { row, draft } = overlayRow(
    { ...LIVE, ...EMBEDS },
    stored(version, conflict) as never,
    RELEASE_REGISTRY.portfolio,
  );
  return { ...portfolioResource.fromRow!(row!), draft };
}

/** What the resolve answers: the same overlay over the live columns it reads, no embeds. */
function resolveAnswer(): Row {
  const { row, draft } = overlayRow(LIVE, stored(3, false) as never, RELEASE_REGISTRY.portfolio);
  return { ...row, draft };
}

describe('settling a conflict from the editor (Keep my version / Use the live version)', () => {
  it('a case study keeps its services and media, and the next save does not empty them', async () => {
    let state: EntitySaveState = entitySaveReducer(initialSaveState(fields, false), {
      type: 'loaded',
      row: itemGet(2, true),
      fields,
      versionFallback: 1,
    });
    expect(state.draft?.conflict).toEqual(['title']);
    expect(state.values['serviceIds']).toEqual([SVC_A, SVC_B]);

    // The answer the server sends has no child sets: adopting it is what emptied them.
    const answer = resolveAnswer();
    expect(answer).not.toHaveProperty('service_ids');
    expect(answer).not.toHaveProperty('media');
    const post = vi.fn<ResolvePost>(async () => answer);
    // What the hook offered before the review (adopt a server row as the form): never used.
    const adoptRow = vi.fn((row: Row) => {
      state = entitySaveReducer(state, { type: 'loaded', row, fields, versionFallback: 1 });
    });
    const save = {
      adoptRow,
      reloadTheirs: vi.fn(async () => {
        state = entitySaveReducer(state, {
          type: 'loaded',
          row: itemGet(3, false),
          fields,
          versionFallback: 1,
        });
      }),
    };

    await settleConflict(save, state.draft!, 'keepMine', post);

    // The person edits another field; the blur's save still carries both child sets.
    state = entitySaveReducer(state, { type: 'set', name: 'year', value: 2025 });
    const body = buildSaveRequest(target, ID, state, fields).body;
    expect(body['serviceIds']).toEqual([SVC_A, SVC_B]);
    expect(body['media']).toEqual([{ role: 'hero', kind: 'image', mediaId: POSTER }]);

    expect(post).toHaveBeenCalledWith(`/api/admin/drafts/${D}/resolve`, {
      method: 'POST',
      body: { version: 2, keepMine: ['title'] },
    });
    expect(save.reloadTheirs).toHaveBeenCalledTimes(1);
    expect(adoptRow).not.toHaveBeenCalled();
    expect(state.draft).toMatchObject({ id: D, version: 3, conflict: [] });
  });

  it('a settle that threw the change away reads the record again too', async () => {
    const post = vi.fn<ResolvePost>(async () => ({ resolved: D, draft: null }));
    const save = { reloadTheirs: vi.fn(async () => undefined) };
    await settleConflict(save, { id: D, version: 2, conflict: ['title'] }, 'useLive', post);
    expect(post).toHaveBeenCalledWith(`/api/admin/drafts/${D}/resolve`, {
      method: 'POST',
      body: { version: 2, useLive: ['title'] },
    });
    expect(save.reloadTheirs).toHaveBeenCalledTimes(1);
  });

  it('a refused settle reads nothing and says why (the caller shows it)', async () => {
    const post = vi.fn<ResolvePost>(async () => {
      throw new Error('refused');
    });
    const save = { reloadTheirs: vi.fn(async () => undefined) };
    await expect(
      settleConflict(save, { id: D, version: 2, conflict: ['title'] }, 'keepMine', post),
    ).rejects.toThrow('refused');
    expect(save.reloadTheirs).not.toHaveBeenCalled();
  });
});
