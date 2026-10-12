import { describe, expect, it } from 'vitest';
import { deltaView, percentChange } from '@/lib/admin/kpi';
import { offsetOf, pageInfo, pageItems, pageParam, rangeText } from '@/lib/admin/pager';
import { arrowStep, rovingIndex, tabFromParam } from '@/lib/admin/roving';
import { NOTE_ICON, NOTE_TONES, isContentStatus, statusLabel } from '@/lib/admin/tones';
import { ICON_NAMES } from '@/lib/admin/icons';

// The component kit's pure models (Admin v2 F4b): paging, arrow keys, the KPI delta and
// the badge words. Shared by the server primitives and the React kit.

describe('pageInfo and rangeText', () => {
  it('reads "26 to 50 of 112" on page 2', () => {
    const info = pageInfo(112, 25, 25);
    expect(info).toEqual({
      total: 112,
      limit: 25,
      offset: 25,
      page: 2,
      pages: 5,
      from: 26,
      to: 50,
    });
    expect(rangeText(info)).toBe('26 to 50 of 112');
  });

  it('ends the last page at the total', () => {
    expect(rangeText(pageInfo(112, 100, 25))).toBe('101 to 112 of 112');
  });

  it('clamps an offset past the end to the last page', () => {
    expect(pageInfo(30, 500, 25)).toMatchObject({ page: 2, offset: 25, from: 26, to: 30 });
  });

  it('says "No results" for an empty list, on one page', () => {
    const info = pageInfo(0, 0, 25);
    expect(info).toMatchObject({ page: 1, pages: 1, from: 0, to: 0 });
    expect(rangeText(info)).toBe('No results');
  });

  it('treats a bad offset or limit as the defaults', () => {
    expect(pageInfo(10, -5, 0)).toMatchObject({ offset: 0, limit: 1, pages: 10 });
    expect(pageInfo(10, Number.NaN)).toMatchObject({ offset: 0, limit: 25 });
  });

  it('groups thousands', () => {
    expect(rangeText(pageInfo(12345, 1000, 25))).toBe('1,001 to 1,025 of 12,345');
  });

  it('maps pages to offsets and back', () => {
    expect(offsetOf(1)).toBe(0);
    expect(offsetOf(3, 25)).toBe(50);
    expect(offsetOf(0)).toBe(0);
    for (let page = 1; page <= 5; page++) expect(pageInfo(112, offsetOf(page)).page).toBe(page);
  });
});

describe('pageItems', () => {
  it('shows every page when there are few', () => {
    expect(pageItems(1, 1)).toEqual([1]);
    expect(pageItems(2, 4)).toEqual([1, 2, 3, 4]);
  });

  it('shows the first, the last and the neighbours, with gaps', () => {
    expect(pageItems(10, 20)).toEqual([1, 'gap', 9, 10, 11, 'gap', 20]);
    expect(pageItems(1, 20)).toEqual([1, 2, 'gap', 20]);
    expect(pageItems(20, 20)).toEqual([1, 'gap', 19, 20]);
  });

  it('shows a single skipped page instead of a gap', () => {
    expect(pageItems(4, 20)).toEqual([1, 2, 3, 4, 5, 'gap', 20]);
    expect(pageItems(17, 20)).toEqual([1, 'gap', 16, 17, 18, 19, 20]);
  });

  it('clamps a page out of range', () => {
    expect(pageItems(99, 3)).toEqual([1, 2, 3]);
    expect(pageItems(0, 0)).toEqual([1]);
  });
});

describe('pageParam', () => {
  it('reads a whole page number from 1, else 1', () => {
    expect(['3', '1', null, undefined, '', '0', '-2', '2.5', 'x'].map(pageParam)).toEqual([
      3, 1, 1, 1, 1, 1, 1, 1, 1,
    ]);
  });
});

describe('arrowStep and rovingIndex', () => {
  it('maps the horizontal arrows, mirrored in RTL', () => {
    expect(arrowStep('ArrowRight')).toBe(1);
    expect(arrowStep('ArrowLeft')).toBe(-1);
    expect(arrowStep('ArrowRight', { rtl: true })).toBe(-1);
    expect(arrowStep('ArrowLeft', { rtl: true })).toBe(1);
    expect(arrowStep('ArrowDown')).toBe(0);
  });

  it('maps the vertical arrows, never mirrored', () => {
    expect(arrowStep('ArrowDown', { orientation: 'vertical', rtl: true })).toBe(1);
    expect(arrowStep('ArrowUp', { orientation: 'vertical' })).toBe(-1);
    expect(arrowStep('ArrowRight', { orientation: 'vertical' })).toBe(0);
    expect(arrowStep('ArrowUp', { orientation: 'both' })).toBe(-1);
    expect(arrowStep('ArrowLeft', { orientation: 'both' })).toBe(-1);
  });

  it('wraps by default and stops at the ends when asked', () => {
    expect(rovingIndex('ArrowRight', 2, 3)).toBe(0);
    expect(rovingIndex('ArrowLeft', 0, 3)).toBe(2);
    expect(rovingIndex('ArrowRight', 2, 3, { wrap: false })).toBe(2);
    expect(rovingIndex('ArrowLeft', 0, 3, { wrap: false })).toBe(0);
  });

  it('goes to the ends with Home and End, and ignores other keys', () => {
    expect(rovingIndex('Home', 2, 5)).toBe(0);
    expect(rovingIndex('End', 0, 5)).toBe(4);
    expect(rovingIndex('Enter', 0, 5)).toBeNull();
    expect(rovingIndex('ArrowRight', 0, 0)).toBeNull();
  });

  it('reads ?tab= against the known tabs', () => {
    const ids = ['content', 'seo', 'media'] as const;
    expect(tabFromParam('seo', ids, 'content')).toBe('seo');
    expect(tabFromParam('nope', ids, 'content')).toBe('content');
    expect(tabFromParam(null, ids, 'content')).toBe('content');
  });
});

describe('the KPI delta', () => {
  it('computes the change in percent, or null with nothing to compare', () => {
    expect(percentChange(120, 100)).toBe(20);
    expect(percentChange(50, 100)).toBe(-50);
    expect(percentChange(5, 0)).toBeNull();
    expect(percentChange(5, null)).toBeNull();
    expect(percentChange(5, undefined)).toBeNull();
    expect(percentChange(Number.NaN, 4)).toBeNull();
  });

  it('reads up, down and flat with an arrow, words and a tone', () => {
    expect(deltaView(12.4)).toEqual({
      trend: 'up',
      tone: 'ok',
      glyph: '▲',
      text: '12%',
      spoken: 'up 12%',
    });
    expect(deltaView(-8)).toMatchObject({
      trend: 'down',
      tone: 'err',
      glyph: '▼',
      spoken: 'down 8%',
    });
    expect(deltaView(0.4)).toMatchObject({
      trend: 'flat',
      tone: 'flat',
      glyph: '•',
      spoken: 'no change',
    });
  });

  it('turns the tone round when fewer is better', () => {
    expect(deltaView(-8, 'down')).toMatchObject({ trend: 'down', tone: 'ok' });
    expect(deltaView(8, 'down')).toMatchObject({ trend: 'up', tone: 'err' });
  });

  it('draws no pill without a change to show', () => {
    expect(deltaView(null)).toBeNull();
    expect(deltaView(undefined)).toBeNull();
    expect(deltaView(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('groups a large change', () => {
    expect(deltaView(1234)?.text).toBe('1,234%');
  });
});

describe('badge and note words', () => {
  it('names every content status in words', () => {
    expect(['draft', 'scheduled', 'published', 'archived', 'pending'].map(statusLabel)).toEqual([
      'Draft',
      'Scheduled',
      'Published',
      'Archived',
      'Pending',
    ]);
    expect(statusLabel('custom')).toBe('custom');
    expect(isContentStatus('draft')).toBe(true);
    expect(isContentStatus(3)).toBe(false);
  });

  it('gives every note tone an icon from the sprite', () => {
    for (const tone of NOTE_TONES) expect(ICON_NAMES).toContain(NOTE_ICON[tone]);
  });
});
