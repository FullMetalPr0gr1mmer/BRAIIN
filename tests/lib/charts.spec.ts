import { describe, expect, it } from 'vitest';
import {
  barBucket,
  barsGeometry,
  clean,
  datumSummary,
  datumTable,
  donutGeometry,
  drawnSeries,
  formatCompact,
  formatNumber,
  lineGeometry,
  n,
  niceScale,
  percentages,
  ringGeometry,
  seriesClass,
  seriesSummary,
  seriesTable,
  sparkGeometry,
  thinLabels,
} from '@/lib/admin/charts';

// Chart geometry (Admin v2 F4b, AV-07 "charts.spec: paths, scales, empty and one-point
// series"). The components only place these numbers, so the numbers are the contract.

describe('values and numbers', () => {
  it('draws anything that is not a finite count of zero or more as 0', () => {
    expect([3, 0, -2, Number.NaN, Infinity, '7', null, undefined].map(clean)).toEqual([
      3, 0, 0, 0, 0, 0, 0, 0,
    ]);
  });

  it('rounds coordinates to one decimal, without "-0" or ".0"', () => {
    expect([1, 1.25, 1.04, -0.01, 33.333].map(n)).toEqual(['1', '1.3', '1', '0', '33.3']);
  });

  it('formats in en-GB with Latin digits', () => {
    expect(formatNumber(1234567)).toBe('1,234,567');
    expect(formatNumber(12.345)).toBe('12.3');
    expect(formatCompact(1200)).toBe('1.2k');
    expect(formatCompact(1_250_000)).toBe('1.3M');
    expect(formatCompact(999)).toBe('999');
    expect(formatCompact(40)).toBe('40');
  });

  it('names series ch-s1 to ch-s7, then starts again', () => {
    expect([0, 1, 6, 7, 13, -1, 1.5].map(seriesClass)).toEqual([
      'ch-s1',
      'ch-s2',
      'ch-s7',
      'ch-s1',
      'ch-s7',
      'ch-s1',
      'ch-s1',
    ]);
  });
});

describe('niceScale', () => {
  it('rounds the top up to a whole step of 1, 2 or 5 × 10^k', () => {
    expect(niceScale(210)).toEqual({ top: 300, step: 100, ticks: [0, 100, 200, 300] });
    expect(niceScale(87)).toEqual({ top: 100, step: 50, ticks: [0, 50, 100] });
    expect(niceScale(1200).ticks).toEqual([0, 500, 1000, 1500]);
  });

  it('never gives counts a fractional step', () => {
    expect(niceScale(3)).toEqual({ top: 3, step: 1, ticks: [0, 1, 2, 3] });
    expect(niceScale(1)).toEqual({ top: 1, step: 1, ticks: [0, 1] });
  });

  it('allows fractional steps when asked, without float noise', () => {
    expect(niceScale(0.3, 4, false).ticks).toEqual([0, 0.1, 0.2, 0.3]);
  });

  it('gives an empty or all-zero series a 0 to 1 scale', () => {
    expect(niceScale(0)).toEqual({ top: 1, step: 1, ticks: [0, 1] });
    expect(niceScale(Number.NaN)).toEqual({ top: 1, step: 1, ticks: [0, 1] });
  });

  it('keeps the top at or above the maximum', () => {
    for (const max of [1, 7, 9, 10, 11, 99, 101, 999, 1001, 12345]) {
      const { top, ticks } = niceScale(max);
      expect(top).toBeGreaterThanOrEqual(max);
      expect(ticks[0]).toBe(0);
      expect(ticks.length).toBeLessThanOrEqual(6);
    }
  });
});

describe('thinLabels', () => {
  it('labels every position up to eight', () => {
    expect(thinLabels(0)).toEqual([]);
    expect(thinLabels(1)).toEqual([0]);
    expect(thinLabels(8)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('labels every step-th position, the first and the last', () => {
    // 30 positions, a step of 4: 28 would sit one place from 29, so 29 takes its place.
    expect(thinLabels(30)).toEqual([0, 4, 8, 12, 16, 20, 24, 29]);
    // 10 positions, a step of 2: 9 is half a step from 8, which is far enough.
    expect(thinLabels(10)).toEqual([0, 2, 4, 6, 8, 9]);
  });

  it('never puts the last label within half a step of the one before', () => {
    for (let count = 9; count <= 120; count++) {
      const out = thinLabels(count);
      const step = Math.ceil(count / 8);
      expect(out[0]).toBe(0);
      expect(out[out.length - 1]).toBe(count - 1);
      for (let i = 1; i < out.length; i++) {
        expect(out[i]! - out[i - 1]!).toBeGreaterThanOrEqual(step / 2);
      }
    }
  });
});

describe('barBucket', () => {
  it('snaps a bar to a 5% bucket of the maximum', () => {
    expect(barBucket(50, 100)).toBe(50);
    expect(barBucket(52, 100)).toBe(50);
    expect(barBucket(53, 100)).toBe(55);
    expect(barBucket(100, 100)).toBe(100);
    expect(barBucket(150, 100)).toBe(100);
  });

  it('never draws an empty bar beside a number above zero', () => {
    expect(barBucket(1, 1000)).toBe(5);
  });

  it('draws nothing for zero, or when everything is zero', () => {
    expect(barBucket(0, 100)).toBe(0);
    expect(barBucket(5, 0)).toBe(0);
  });

  it('lands on a bucket admin.css defines (0, 5 … 100)', () => {
    for (let v = 0; v <= 1000; v += 7) expect(barBucket(v, 1000) % 5).toBe(0);
  });
});

describe('percentages', () => {
  it('adds up to 100 by the largest remainder', () => {
    expect(percentages([1, 1, 1])).toEqual([34, 33, 33]);
    expect(percentages([2, 1, 1])).toEqual([50, 25, 25]);
    expect(percentages([1, 2, 3, 4, 5, 6, 7]).reduce((a, b) => a + b)).toBe(100);
  });

  it('keeps zeros at zero', () => {
    expect(percentages([0, 0])).toEqual([0, 0]);
    expect(percentages([0, 5])).toEqual([0, 100]);
  });
});

describe('sparkGeometry', () => {
  it('draws the prototype spark: a line and an area closed along the bottom', () => {
    const spark = sparkGeometry([0, 5, 10]);
    expect(spark).toEqual({
      width: 200,
      height: 36,
      line: 'M0 33 L100 18 L200 3',
      area: 'M0 33 L100 18 L200 3 L200 36 L0 36 Z',
    });
  });

  it('gives no spark for no data', () => {
    expect(sparkGeometry([])).toBeNull();
  });

  it('draws one point as a flat line across the box', () => {
    expect(sparkGeometry([4])?.line).toBe('M0 3 L200 3');
  });

  it('keeps an all-zero series on the baseline', () => {
    expect(sparkGeometry([0, 0])?.line).toBe('M0 33 L200 33');
  });
});

describe('lineGeometry', () => {
  const labels = ['1 Oct', '2 Oct', '3 Oct', '4 Oct', '5 Oct'];

  it('places points in the plot, under a round scale', () => {
    const g = lineGeometry([{ name: 'Visits', data: [0, 50, 100, 150, 200] }], labels)!;
    expect(g.plot).toEqual({ left: 44, right: 790, top: 14, bottom: 212 });
    expect(g.ticks.map((t) => t.label)).toEqual(['0', '50', '100', '150', '200']);
    expect(g.ticks[0]!.y).toBe(212);
    expect(g.ticks[g.ticks.length - 1]!.y).toBe(14);
    expect(g.series[0]!.line).toBe('M44 212 L230.5 162.5 L417 113 L603.5 63.5 L790 14');
    expect(g.series[0]!.area).toBe(`${g.series[0]!.line} L790 212 L44 212 Z`);
    expect(g.series[0]!.className).toBe('ch-s1');
    expect(g.dots).toBe(false);
  });

  it('labels the x axis at the thinned positions', () => {
    const g = lineGeometry([{ name: 'V', data: [1, 2, 3, 4, 5] }], labels)!;
    expect(g.xLabels.map((l) => l.label)).toEqual(labels);
    expect(g.xLabels[0]!.x).toBe(44);
  });

  it('gives each series its own class, the second dashed by admin.css', () => {
    const g = lineGeometry(
      [
        { name: 'Visits', data: [1, 2] },
        { name: 'Leads', data: [0, 1] },
      ],
      ['a', 'b'],
    )!;
    expect(g.series.map((s) => s.className)).toEqual(['ch-s1', 'ch-s2']);
  });

  it('has nothing to draw for no labels and no data, or only empty series', () => {
    expect(lineGeometry([], [])).toBeNull();
    expect(lineGeometry([{ name: 'V', data: [] }], labels)).toBeNull();
  });

  it('draws a one-point series as a dot in the middle of the plot', () => {
    const g = lineGeometry([{ name: 'V', data: [7] }], ['Today'])!;
    expect(g.dots).toBe(true);
    // 7 on a 0 to 8 scale: seven eighths of the way up the 198px plot.
    expect(g.series[0]!.points).toEqual([{ x: 417, y: 38.75, value: 7 }]);
    expect(g.series[0]!.area).toBe('');
  });

  it('counts positions from the longest series when there are no labels', () => {
    const g = lineGeometry([{ name: 'V', data: [1, 2, 3] }], [])!;
    expect(g.series[0]!.points).toHaveLength(3);
    expect(g.xLabels.map((l) => l.label)).toEqual(['', '', '']);
  });
});

describe('barsGeometry', () => {
  it('fills 60% of each slot and lets the tallest bar reach the top', () => {
    const g = barsGeometry([
      { label: 'Logo', value: 10 },
      { label: 'Cards', value: 5 },
    ])!;
    expect(g.baseline).toBe(174);
    const [a, b] = g.bars;
    expect(a).toMatchObject({ x: 60, width: 180, y: 18, height: 156, cx: 150, labelled: true });
    expect(b).toMatchObject({ x: 360, width: 180, height: 78, cx: 450 });
  });

  it('draws zero as no height, on the baseline', () => {
    const g = barsGeometry([
      { label: 'A', value: 0 },
      { label: 'B', value: 0 },
    ])!;
    expect(g.bars.every((bar) => bar.height === 0 && bar.y === g.baseline)).toBe(true);
  });

  it('has nothing to draw for no data, and draws one bar alone', () => {
    expect(barsGeometry([])).toBeNull();
    expect(barsGeometry([{ label: 'Only', value: 3 }])!.bars[0]).toMatchObject({ x: 120, cx: 300 });
  });
});

describe('donutGeometry and ringGeometry', () => {
  const c = 2 * Math.PI * 42;

  it('offsets each share by the ones before it', () => {
    const g = donutGeometry([
      { label: 'Branding', value: 1 },
      { label: 'Production', value: 3 },
    ]);
    expect(g.total).toBe(4);
    expect(g.segments.map((s) => s.percent)).toEqual([25, 75]);
    expect(g.segments[0]).toMatchObject({
      dasharray: `${n(c / 4)} ${n((3 * c) / 4)}`,
      dashoffset: '0',
      className: 'ch-s1',
      drawn: true,
    });
    expect(g.segments[1]!.dashoffset).toBe(n(-c / 4));
  });

  it('keeps a zero share in the legend but out of the drawing', () => {
    const g = donutGeometry([
      { label: 'A', value: 0 },
      { label: 'B', value: 2 },
    ]);
    expect(g.segments.map((s) => s.drawn)).toEqual([false, true]);
    expect(g.segments[1]!.dasharray).toBe(`${n(c)} 0`);
  });

  it('draws nothing for no data or all zeros', () => {
    expect(donutGeometry([]).segments).toEqual([]);
    expect(donutGeometry([{ label: 'A', value: 0 }]).segments[0]!.drawn).toBe(false);
  });

  it('draws a ring as a share of its maximum, clamped', () => {
    expect(ringGeometry(50).dasharray).toBe(`${n(c / 2)} ${n(c)}`);
    expect(ringGeometry(150).fraction).toBe(1);
    expect(ringGeometry(-3).fraction).toBe(0);
    expect(ringGeometry(5, 0).fraction).toBe(0);
  });
});

describe('the text alternatives come from the same data', () => {
  const series = [
    { name: 'Visits', data: [10, 40, 25] },
    { name: 'Leads', data: [1, 2] },
  ];
  const labels = ['1 Oct', '2 Oct', '3 Oct'];

  it('tables a line chart: one row per label, one column per series', () => {
    expect(seriesTable(series, labels)).toEqual({
      head: ['Date', 'Visits', 'Leads'],
      rows: [
        ['1 Oct', '10', '1'],
        ['2 Oct', '40', '2'],
        ['3 Oct', '25', ''],
      ],
    });
  });

  it('summarises a line chart by its highest and latest values', () => {
    expect(seriesSummary(series, labels)).toBe(
      'Visits: highest 40 (2 Oct), latest 25 (3 Oct). Leads: highest 2 (2 Oct), latest 2 (2 Oct).',
    );
    expect(seriesSummary([], [])).toBe('No data yet.');
  });

  it('a series longer than its labels: summary, table, scale and points all stop at the last label', () => {
    // One value more than there are dates: it is not drawn, so the image's name must not cite it
    // (f4b review: the summary read the whole series, the drawing and the table did not).
    const long = [{ name: 'Visits', data: [3, 5, 4, 99] }];
    const dates = ['1 Oct', '2 Oct', '3 Oct'];
    expect(seriesSummary(long, dates)).toBe('Visits: highest 5 (2 Oct), latest 4 (3 Oct).');
    expect(seriesTable(long, dates).rows).toEqual([
      ['1 Oct', '3'],
      ['2 Oct', '5'],
      ['3 Oct', '4'],
    ]);
    const g = lineGeometry(long, dates);
    expect(g?.series[0]?.points.map((p) => p.value)).toEqual([3, 5, 4]);
    // The scale is the drawn values', not the undrawn 99's.
    expect(g?.ticks.at(-1)?.value).toBeLessThan(99);
    expect(drawnSeries(long, dates)).toEqual([{ name: 'Visits', data: [3, 5, 4] }]);
    // Unlabelled, every value is a position and is kept.
    expect(drawnSeries(long, [])).toEqual(long);
  });

  it('tables bars and shares', () => {
    const data = [
      { label: 'Logo', value: 3 },
      { label: 'Cards', value: 1 },
    ];
    expect(datumTable(data, { labelHeading: 'Service', valueHeading: 'Leads' })).toEqual({
      head: ['Service', 'Leads'],
      rows: [
        ['Logo', '3'],
        ['Cards', '1'],
      ],
    });
    expect(datumTable(data, { shares: true }).rows).toEqual([
      ['Logo', '3', '75%'],
      ['Cards', '1', '25%'],
    ]);
  });

  it('summarises bars and shares by the largest item', () => {
    const data = [
      { label: 'Logo', value: 3 },
      { label: 'Cards', value: 1 },
    ];
    expect(datumSummary(data)).toBe('Highest: Logo, 3. Total 4.');
    expect(datumSummary(data, { shares: true })).toBe('Largest: Logo, 75% of 4.');
    expect(datumSummary([{ label: 'A', value: 0 }])).toBe('No data yet.');
  });
});
