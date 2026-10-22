import { describe, expect, it } from 'vitest';
import { RELEASE_ENTITY_TYPES, type ReleaseEntityType } from '@schemas/release';
import { RELEASE_REGISTRY } from '@/lib/release/registry';
import { derivePatch } from '@/lib/release/overlay';
import {
  childrenPayload,
  restoreOnlyColumns,
  restorePatch,
  rowToPayload,
} from '@/lib/release/rowPayload';
import { jsonEqual } from '@/lib/release/deepEqual';
import { dropFields } from '@/lib/release/drafts';
import { narrowed } from '@/lib/release/revert';
import type { PortfolioMediaItem } from '@schemas/admin';
import { mediaItemToRow } from '@/lib/admin/resources/portfolio';
import { samplesFor } from '../fixtures/resourceSamples';

// A stored row back to the change that writes it (Admin v2 R10, src/lib/release/rowPayload.ts).
// For every release-managed type: a full change (every payload key the entity knows) is mapped
// to its columns as a publish maps it, the columns are read back into a payload, and that
// payload must write exactly those columns again. A type whose editor gains a key the inverse
// cannot read fails here, before a restore could stage something the version did not hold.

type Row = Record<string, unknown>;

const BI = (en: string, ar: string) => ({ en, ar });
const PAGE = '0f0f0f0f-0000-4000-8000-00000000000a';

/** Values that make one type's full sample pass its schema (the fixture's are plain values). */
const OVERRIDES: Partial<Record<ReleaseEntityType, Row>> = {
  service: { valuePoints: [{ title: BI('Point', 'نقطة'), text: BI('Why', 'لماذا') }] },
  portfolio: { keywords: [BI('Brand', 'هوية')] },
  service_case: {
    problems: [{ problem: BI('Problem', 'مشكلة'), solution: BI('Solution', 'حل') }],
  },
  page_section: { type: 'cta', content: { heading: BI('Heading', 'عنوان') } },
  page_visibility: {
    target: { pageId: PAGE },
    mode: 'hidden',
    redirectPageId: null,
    hideFrom: '2026-11-02',
    showOn: '2026-11-09',
  },
};

/** The sample payload of one type: every key it knows, never a schedule. */
function fullPayload(type: ReleaseEntityType): Row {
  const entry = RELEASE_REGISTRY[type];
  const samples = samplesFor(type);
  const out: Row = {};
  for (const key of [...Object.keys(entry.fields), ...entry.childKeys]) {
    if (key === 'scheduledFor' || !(key in samples)) continue;
    out[key] = samples[key];
  }
  return { ...out, ...(OVERRIDES[type] ?? {}) };
}

describe('rowToPayload: every type round-trips', () => {
  for (const type of RELEASE_ENTITY_TYPES) {
    it(`${type}: a stored image comes back as the change that writes it`, () => {
      const entry = RELEASE_REGISTRY[type];
      const payload = fullPayload(type);
      const first = derivePatch(entry, 'create', payload);
      const image: Row = { ...first.patch };
      // A case study's link sets as the ledger keeps them (rows of portfolio_media).
      const children =
        entry.childKeys.length > 0
          ? {
              service_ids: payload['serviceIds'],
              media: (payload['media'] as PortfolioMediaItem[]).map(mediaItemToRow),
            }
          : null;
      const back = restorePatch(entry, 'create', image, children);
      expect(back).toMatchObject({ ok: true });
      if (!back.ok) return;
      for (const [column, value] of Object.entries(image)) {
        expect(jsonEqual(back.derived.patch[column], value), `${type}.${column}`).toBe(true);
      }
      expect(Object.keys(back.derived.patch).sort()).toEqual(Object.keys(image).sort());
      expect(jsonEqual(back.derived.children, first.children), `${type} link sets`).toBe(true);
    });
  }
});

describe('a restore derives its change once (P-15)', () => {
  // planRestore cuts the round trip's whole change down to the keys whose columns moved
  // (`narrowed`) instead of deriving the cut payload again: the same columns and values, for
  // any one key moved and for all of them.
  const PARTIAL: ReadonlySet<string> = new Set(['entitySeo', 'pageVisibility']);
  for (const type of RELEASE_ENTITY_TYPES) {
    const entry = RELEASE_REGISTRY[type];
    if (PARTIAL.has(entry.kind)) continue;
    it(`${type}: the cut change equals a fresh derive of the cut payload`, () => {
      const payload = fullPayload(type);
      const image: Row = { ...derivePatch(entry, 'create', payload).patch };
      const children =
        entry.childKeys.length > 0
          ? {
              service_ids: payload['serviceIds'],
              media: (payload['media'] as PortfolioMediaItem[]).map(mediaItemToRow),
            }
          : null;
      const back = restorePatch(entry, 'update', image, children);
      expect(back).toMatchObject({ ok: true });
      if (!back.ok) return;
      const moves = [
        ...Object.keys(back.payload).map((key) => entry.fields[key] ?? []),
        Object.keys(back.derived.patch),
      ];
      for (const moved of moves) {
        const cut = dropFields(entry, back.payload, moved);
        const fresh = derivePatch(entry, 'update', cut);
        const once = narrowed(entry, back.derived, cut);
        expect(once.patch, `${type} ${moved.join(',')}`).toEqual(fresh.patch);
        expect(once.children, `${type} ${moved.join(',')} sets`).toEqual(fresh.children);
        expect(once.exempt).toEqual(fresh.exempt);
      }
    });
  }
});

describe('rowToPayload: the pieces', () => {
  it('reads nothing that is not in the image, and never an immediate column', () => {
    const entry = RELEASE_REGISTRY.site_profile;
    const payload = rowToPayload(entry, { brand_name: { en: 'X' }, accepting_applications: true });
    expect(payload).toEqual({ brandName: { en: 'X' } });
  });

  it('a clip is rebuilt from its preview columns', () => {
    const payload = rowToPayload(RELEASE_REGISTRY.service, {
      preview_video_path: '/media/reel.mp4',
      preview_start_s: 2,
      preview_end_s: 6,
    });
    expect(payload['clip']).toEqual({ path: '/media/reel.mp4', startS: 2, endS: 6 });
    expect(rowToPayload(RELEASE_REGISTRY.service, { preview_video_path: null })['clip']).toBe(null);
  });

  it('a case study keeps its Stream uid in its preview', () => {
    const payload = rowToPayload(RELEASE_REGISTRY.portfolio, {
      preview_video_uid: 'uid-1',
      preview_video_path: null,
      preview_start_s: null,
      preview_end_s: null,
    });
    expect(payload['preview']).toEqual({ streamUid: 'uid-1' });
  });

  it('link sets come from the ledger image, media rows as the editor reads them', () => {
    expect(
      childrenPayload({
        service_ids: ['a'],
        media: [{ role: 'hero', kind: 'image', media_id: 'm', caption: null }],
      }),
    ).toEqual({ serviceIds: ['a'], media: [{ role: 'hero', kind: 'image', mediaId: 'm' }] });
    expect(childrenPayload(null)).toEqual({});
  });

  it('page visibility: the target, and its dates as Riyadh days', () => {
    const payload = rowToPayload(RELEASE_REGISTRY.page_visibility, {
      page_id: '0f0f0f0f-0000-4000-8000-00000000000a',
      template: null,
      mode: 'hidden',
      redirect_page_id: null,
      hide_from: '2026-11-01T21:00:00+00:00',
      show_on: null,
    });
    expect(payload).toEqual({
      target: { pageId: '0f0f0f0f-0000-4000-8000-00000000000a' },
      mode: 'hidden',
      redirectPageId: null,
      hideFrom: '2026-11-02',
      showOn: null,
    });
  });

  it("restore-only columns are named (a section's legacy style, a gate's note)", () => {
    expect(restoreOnlyColumns(RELEASE_REGISTRY.page_section)).toContain('style');
    expect(restoreOnlyColumns(RELEASE_REGISTRY.page_visibility)).toContain('note');
    expect(restoreOnlyColumns(RELEASE_REGISTRY.service)).toEqual([]);
  });

  it("a value today's schema refuses is a refusal, never a change", () => {
    const back = restorePatch(RELEASE_REGISTRY.service, 'update', {
      slug: 'Not A Slug',
      title: { en: 'X', ar: 'س' },
    });
    expect(back).toEqual({ ok: false, reason: 'unreadable', columns: [] });
  });

  it('a column that does not come back is named', () => {
    // A password mode cannot be set by a change (the password door sets it).
    const back = restorePatch(RELEASE_REGISTRY.page_visibility, 'update', {
      page_id: '0f0f0f0f-0000-4000-8000-00000000000a',
      template: null,
      mode: 'password',
      redirect_page_id: null,
      hide_from: null,
      show_on: null,
    });
    expect(back.ok).toBe(false);
  });
});
