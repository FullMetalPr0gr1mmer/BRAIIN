import { describe, expect, it, vi } from 'vitest';
import { itemRoutes } from '@/lib/admin/resource';
import { themeResource } from '@/lib/admin/resources/themes';
import { inCurrentShape } from '@/lib/release/currentShape';
import { dropNoOps } from '@/lib/release/overlay';
import { T, type Row } from '../fixtures/stagedDb';
import { callRoute, liveWritesOf, makeDb } from '../fixtures/stagedRoute';

// A theme saved before Admin v2 E12 (v1) in the release lane (E12 code review CR5). Today's
// save derives v2 (the brand's shapes and type for a v1 theme), while the live row, a change's
// base and a ledger image can still hold v1. Every comparison reads the stored side in today's
// shape (src/lib/release/currentShape.ts), so the same theme is no change: no pending change,
// no history entry, no column a restore moves. What is RECORDED stays as stored: a base keeps
// the v1 value, because apply_release compares a base with the live column as stored.
// The version list and a restore are covered in tests/lib/releaseVersions.spec.ts.

vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));
vi.mock('@/lib/admin/audit', () => ({ writeAudit: async () => undefined }));

const THEME = '0d0d0d0d-0000-4000-8000-000000000001';
const COLOURS = { primary: '#0024BC', hover: '#024CFF', accent: '#22A9FF' };
const MOTION = { marquee: 'normal', reveal: true };
/** The brand's own theme as E4 saved it. */
const V1 = { v: 1, mode: 'simple', colors: COLOURS, motion: MOTION };
/** The same theme as the editor saves it since E12. */
const V2 = {
  v: 2,
  mode: 'simple',
  colors: COLOURS,
  motion: MOTION,
  shapes: { corners: 'brand', buttons: 'pill' },
  type: { headingWeight: 800, headingCase: 'uppercase' },
};

const liveTheme = (over: Row = {}): Row => ({
  id: THEME,
  tenant_id: T,
  name: 'Site theme',
  settings: V1,
  tokens: {},
  is_active: true,
  version: 4,
  created_at: '2026-10-01T09:00:00+00:00',
  updated_at: '2026-10-01T09:00:00+00:00',
  ...over,
});

const patch = (db: ReturnType<typeof makeDb>, body: Row) =>
  callRoute(db, itemRoutes(themeResource).PATCH, 'PATCH', `/api/admin/themes/${THEME}`, {
    body,
    params: { id: THEME },
  });
const drafts = (db: ReturnType<typeof makeDb>) => db.tables['content_drafts'] ?? [];

describe('a v1 theme and the same theme as v2 are the same (releases on)', () => {
  it('saving it back unchanged stages nothing: no pending change, no live write', async () => {
    const db = makeDb({ custom_themes: [liveTheme()] });
    const res = await patch(db, { name: 'Site theme', settings: V2, isActive: true, version: 4 });
    expect(res.status).toBe(200);
    expect(drafts(db)).toEqual([]);
    expect(liveWritesOf(db, 'custom_themes')).toEqual([]);
  });

  it('a new name stages the name alone, never the settings', async () => {
    const db = makeDb({ custom_themes: [liveTheme()] });
    const res = await patch(db, { name: 'Night', settings: V2, isActive: true, version: 4 });
    expect(res.status).toBe(200);
    expect(drafts(db)).toHaveLength(1);
    const [draft] = drafts(db);
    expect(draft!['payload']).toEqual({ name: 'Night' });
    expect(draft!['fields']).toEqual(['name']);
  });

  it('a real change of colour is staged, and its base keeps the stored v1 (as apply_release reads live)', async () => {
    const db = makeDb({ custom_themes: [liveTheme()] });
    const green = { ...V2, colors: { primary: '#095A34', hover: '#077545', accent: '#2FEF55' } };
    const res = await patch(db, {
      name: 'Site theme',
      settings: green,
      isActive: true,
      version: 4,
    });
    expect(res.status).toBe(200);
    const [draft] = drafts(db);
    expect(draft!['payload']).toMatchObject({ settings: green });
    expect((draft!['base'] as Row)['settings']).toEqual(V1);
  });
});

describe('dropNoOps and inCurrentShape', () => {
  it('a v1 live row and its base against an unchanged v2 patch: same as live, nothing left', () => {
    const live = { settings: V1, tokens: {}, name: 'Site theme' };
    expect(dropNoOps('custom_theme', { settings: V2, tokens: {} }, live)).toBeNull();
    expect(dropNoOps('custom_theme', { settings: V2, tokens: {} }, live, { settings: V1 })).toBe(
      null,
    );
    // A real change stays.
    const moved = { ...V2, motion: { marquee: 'slower', reveal: true } };
    expect(dropNoOps('custom_theme', { settings: moved }, live)).toEqual({ settings: moved });
  });

  it('only the theme is read in today’s shape; a row with nothing to upgrade is the same object', () => {
    const v1Row = { settings: V1, name: 'x' };
    expect(inCurrentShape('custom_theme', v1Row)).toEqual({ settings: V2, name: 'x' });
    // The stored row itself is never changed.
    expect(v1Row.settings).toBe(V1);
    const v2Row = { settings: V2 };
    expect(inCurrentShape('custom_theme', v2Row)).toBe(v2Row);
    // Another entity's `settings` with a `v: 1` is not a theme's.
    const other = { settings: { v: 1 } };
    expect(inCurrentShape('site_settings', other)).toBe(other);
    expect(inCurrentShape('custom_theme', null)).toBeNull();
  });
});
