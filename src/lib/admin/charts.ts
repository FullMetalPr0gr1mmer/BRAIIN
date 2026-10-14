// Chart geometry for the admin (Admin v2 F4b, docs/admin-v2/ui.md §1.6, §2.4, AV-07): pure
// functions from data to SVG attribute values, so the charts are server-rendered SVG with
// no chart library and no inline style (style-src is nonce-only). The components in
// src/components/admin/ui/charts/ only place what these return.
//
// The prototype's shapes, kept: an 800×240 line chart with four gridlines and at most eight
// x labels, a 200×36 spark, 600-wide vertical bars, a donut and a ring of radius 42 in a
// 100×100 box, drawn with stroke-dasharray. What changed, and why:
//   - no colour literal reaches the markup: a series is a class (`ch-s1` … `ch-s7`), which
//     admin.css maps to the `--ad-series-*` tokens (each >= 3:1 on a card, audited), and
//     the second series is dashed, so colour is never the only cue (WCAG 1.4.1);
//   - no value lives only in a hover <title>: every chart's figure carries a "View as
//     table" built by seriesTable / datumTable from the SAME data as the drawing, and a
//     one-line summary for the image's accessible name (the AV-07 risk: text alternatives
//     drifting from the chart);
//   - empty and one-point series are drawn, not divided by zero: no data gives null (the
//     figure says so in words) and one point is a dot.
// The charts count things (visits, leads, bytes): a value that is not a finite number of
// zero or more is drawn as 0.

export const SERIES_COUNT = 7;

/** The class for the series at a 0-based position: ch-s1 … ch-s7, then round again. */
export function seriesClass(index: number): string {
  const n = Number.isInteger(index) && index >= 0 ? index : 0;
  return `ch-s${(n % SERIES_COUNT) + 1}`;
}

const NUMBER = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 });

/** 12,345 or 12.5: Latin digits and en-GB grouping, the admin's language. */
export const formatNumber = (n: number): string => NUMBER.format(n);

/**
 * 1.2k, 3.4M: for axis ticks, where space is short (the table keeps the full number).
 * Written out rather than Intl's compact notation, whose letters vary between ICU builds
 * ("1.2K" or "1.2k").
 */
export function formatCompact(n: number): string {
  const abs = Math.abs(n);
  for (const [size, unit] of [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'k'],
  ] as const) {
    if (abs >= size) return `${formatNumber(Math.round((n / size) * 10) / 10)}${unit}`;
  }
  return formatNumber(n);
}

/** A value the charts can draw: finite and at least zero, else 0. */
export function clean(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Rounds a coordinate for an SVG attribute: one decimal, no "-0", no trailing ".0". */
export function n(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

export interface Scale {
  /** The value at the top of the plot: the data's maximum rounded up to a whole step. */
  top: number;
  step: number;
  /** 0, step, 2 × step … top. */
  ticks: number[];
}

/**
 * A y scale with round gridlines: a step of 1, 2 or 5 times a power of ten giving about
 * `target` intervals, and a top that is a whole number of steps at or above the maximum.
 * Counts never get a fractional step (`integers`, the default). No data, or all zeros,
 * gives a 0 to 1 scale, so a flat line sits on the baseline.
 */
export function niceScale(max: number, target = 4, integers = true): Scale {
  const peak = clean(max);
  if (peak === 0) return { top: 1, step: 1, ticks: [0, 1] };
  const raw = peak / Math.max(1, target);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / magnitude;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  let step = nice * magnitude;
  if (integers && step < 1) step = 1;
  const count = Math.ceil(peak / step - 1e-9);
  const ticks = Array.from({ length: count + 1 }, (_, k) => Number((k * step).toPrecision(12)));
  return { top: ticks[ticks.length - 1] ?? step, step, ticks };
}

/**
 * Which of `count` x positions get a label: all of them up to `max`, else every step-th,
 * always the first and the last. When the last would sit closer than half a step to the
 * one before it, it takes that one's place, so two labels never overlap.
 */
export function thinLabels(count: number, max = 8): number[] {
  if (count <= 0) return [];
  if (count <= max) return Array.from({ length: count }, (_, i) => i);
  const step = Math.ceil(count / max);
  const out: number[] = [];
  for (let i = 0; i < count; i += step) out.push(i);
  const last = count - 1;
  if (out[out.length - 1] !== last) {
    if (last - (out[out.length - 1] ?? 0) < step / 2) out.pop();
    out.push(last);
  }
  return out;
}

/**
 * A bar's width bucket, 0 to 100 in fives, for `.bar-fill[data-width]` (admin.css; a
 * style attribute would be refused). Any value above zero gets at least 5, so a bar is
 * never empty beside a number that is not.
 */
export function barBucket(value: number, max: number): number {
  const v = clean(value);
  const m = clean(max);
  if (v === 0 || m === 0) return 0;
  return Math.min(100, Math.max(5, Math.round(((v / m) * 100) / 5) * 5));
}

/**
 * Whole percentages that add up to 100 (largest remainder), so a donut's legend never
 * reads 33 + 33 + 33. All zeros stay zeros.
 */
export function percentages(values: readonly number[]): number[] {
  const counts = values.map(clean);
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return counts.map(() => 0);
  const exact = counts.map((v) => (v / total) * 100);
  const floors = exact.map(Math.floor);
  let left = 100 - floors.reduce((a, b) => a + b, 0);
  const order = exact
    .map((v, i) => ({ i, rest: v - Math.floor(v) }))
    .sort((a, b) => b.rest - a.rest || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i] = (floors[i] ?? 0) + 1;
    left--;
  }
  return floors;
}

// ---- Spark (a KPI's trend; decorative, aria-hidden) -------------------------------------

export interface SparkGeometry {
  width: number;
  height: number;
  line: string;
  area: string;
}

/**
 * The prototype's spark: a line and a soft area in a 200×36 box, the baseline at zero.
 * No data gives null; one point gives a flat line across the box.
 */
export function sparkGeometry(
  data: readonly number[],
  width = 200,
  height = 36,
  pad = 3,
): SparkGeometry | null {
  const values = data.map(clean);
  if (values.length === 0) return null;
  const max = Math.max(...values, 1);
  const y = (v: number) => height - pad - (v / max) * (height - 2 * pad);
  const points: [number, number][] =
    values.length === 1
      ? [
          [0, y(values[0] ?? 0)],
          [width, y(values[0] ?? 0)],
        ]
      : values.map((v, i) => [(i / (values.length - 1)) * width, y(v)]);
  const line = points.map(([px, py], i) => `${i ? 'L' : 'M'}${n(px)} ${n(py)}`).join(' ');
  return { width, height, line, area: `${line} L${n(width)} ${n(height)} L0 ${n(height)} Z` };
}

// ---- Line (one or more series over the same labels) -------------------------------------

export interface Series {
  name: string;
  data: readonly number[];
}

export interface LineGeometry {
  width: number;
  height: number;
  plot: { left: number; right: number; top: number; bottom: number };
  ticks: { value: number; y: number; label: string }[];
  xLabels: { index: number; x: number; label: string }[];
  series: {
    name: string;
    className: string;
    line: string;
    area: string;
    points: { x: number; y: number; value: number }[];
  }[];
  /** True when a series has a single point: it is drawn as a dot, a line would be nothing. */
  dots: boolean;
}

export interface LineOptions {
  width?: number;
  height?: number;
}

/** How many x positions a chart has: its labels, or the longest series when unlabelled. */
function positions(series: readonly Series[], labels: readonly string[]): number {
  return labels.length > 0 ? labels.length : Math.max(0, ...series.map((s) => s.data.length));
}

/**
 * Each series cut to the chart's x positions: the values that are drawn. The drawing, its
 * scale, its table and its summary all read these, so a value past the last label (a
 * series one longer than its dates) is in none of them rather than only in the summary.
 */
export function drawnSeries(series: readonly Series[], labels: readonly string[]): Series[] {
  const count = positions(series, labels);
  return series.map((s) => ({ ...s, data: s.data.slice(0, count) }));
}

/**
 * The prototype's line chart: a 44px gutter for the y ticks, 28px under the plot for the x
 * labels, four round gridlines, one path and one soft area per series. Null when there is
 * no point to draw.
 */
export function lineGeometry(
  allSeries: readonly Series[],
  labels: readonly string[],
  { width = 800, height = 240 }: LineOptions = {},
): LineGeometry | null {
  const series = drawnSeries(allSeries, labels);
  const count = positions(series, labels);
  const drawn = series.filter((s) => s.data.length > 0);
  if (count === 0 || drawn.length === 0) return null;
  const plot = { left: 44, right: width - 10, top: 14, bottom: height - 28 };
  const scale = niceScale(Math.max(...drawn.flatMap((s) => s.data.map(clean))));
  const x = (i: number) =>
    count === 1
      ? (plot.left + plot.right) / 2
      : plot.left + (i / (count - 1)) * (plot.right - plot.left);
  const y = (v: number) => plot.bottom - (clean(v) / scale.top) * (plot.bottom - plot.top);
  const geometry = series.map((s, index) => {
    const points = s.data.map((v, i) => ({ x: x(i), y: y(v), value: clean(v) }));
    const line = points.map((p, i) => `${i ? 'L' : 'M'}${n(p.x)} ${n(p.y)}`).join(' ');
    const first = points[0];
    const last = points[points.length - 1];
    const area =
      first && last && points.length > 1
        ? `${line} L${n(last.x)} ${n(plot.bottom)} L${n(first.x)} ${n(plot.bottom)} Z`
        : '';
    return { name: s.name, className: seriesClass(index), line, area, points };
  });
  return {
    width,
    height,
    plot,
    ticks: scale.ticks.map((value) => ({ value, y: y(value), label: formatCompact(value) })),
    xLabels: thinLabels(count).map((index) => ({ index, x: x(index), label: labels[index] ?? '' })),
    series: geometry,
    dots: geometry.some((s) => s.points.length === 1),
  };
}

// ---- Vertical bars ----------------------------------------------------------------------

export interface Datum {
  label: string;
  value: number;
}

export interface BarsGeometry {
  width: number;
  height: number;
  baseline: number;
  bars: {
    label: string;
    value: number;
    x: number;
    y: number;
    width: number;
    height: number;
    /** The centre of the bar, for its label and value. */
    cx: number;
    /** Whether this bar's label is drawn (at most eight are; the table has them all). */
    labelled: boolean;
  }[];
}

/**
 * The prototype's vertical bars: one slot per value, the bar 60% of its slot, 26px under
 * the baseline for the labels and 18px over the tallest bar for its value. The tallest
 * bar reaches the top (bars compare with each other; the value is written on each).
 */
export function barsGeometry(
  data: readonly Datum[],
  { width = 600, height = 200 }: LineOptions = {},
): BarsGeometry | null {
  if (data.length === 0) return null;
  const baseline = height - 26;
  const room = baseline - 18;
  const max = Math.max(...data.map((d) => clean(d.value)), 1);
  const slot = width / data.length;
  const labelled = new Set(thinLabels(data.length));
  return {
    width,
    height,
    baseline,
    bars: data.map((d, i) => {
      const value = clean(d.value);
      const h = (value / max) * room;
      return {
        label: d.label,
        value,
        x: i * slot + slot * 0.2,
        y: baseline - h,
        width: slot * 0.6,
        height: h,
        cx: i * slot + slot / 2,
        labelled: labelled.has(i),
      };
    }),
  };
}

// ---- Donut and ring ---------------------------------------------------------------------

export const DONUT_RADIUS = 42;

export interface DonutGeometry {
  radius: number;
  circumference: number;
  total: number;
  segments: {
    label: string;
    value: number;
    percent: number;
    className: string;
    /** `stroke-dasharray`: the segment's length, then the rest of the circle. */
    dasharray: string;
    /** `stroke-dashoffset`: minus the length of the segments before it. */
    dashoffset: string;
    /** False for a zero share: it stays in the legend and the table, not in the drawing. */
    drawn: boolean;
  }[];
}

/** The prototype's donut: one stroked circle per share, each offset by the ones before. */
export function donutGeometry(data: readonly Datum[], radius = DONUT_RADIUS): DonutGeometry {
  const circumference = 2 * Math.PI * radius;
  const values = data.map((d) => clean(d.value));
  const total = values.reduce((a, b) => a + b, 0);
  const shares = percentages(values);
  let before = 0;
  return {
    radius,
    circumference,
    total,
    segments: data.map((d, i) => {
      const value = values[i] ?? 0;
      const length = total === 0 ? 0 : (value / total) * circumference;
      const segment = {
        label: d.label,
        value,
        percent: shares[i] ?? 0,
        className: seriesClass(i),
        dasharray: `${n(length)} ${n(circumference - length)}`,
        dashoffset: n(-before),
        drawn: length > 0,
      };
      before += length;
      return segment;
    }),
  };
}

export interface RingGeometry {
  radius: number;
  circumference: number;
  /** The share drawn, 0 to 1. */
  fraction: number;
  dasharray: string;
}

/** A score ring (Site health's 0 to 100): the arc's length as a share of `max`. */
export function ringGeometry(value: number, max = 100, radius = DONUT_RADIUS): RingGeometry {
  const circumference = 2 * Math.PI * radius;
  const top = clean(max);
  const fraction = top === 0 ? 0 : Math.min(1, clean(value) / top);
  return {
    radius,
    circumference,
    fraction,
    dasharray: `${n(fraction * circumference)} ${n(circumference)}`,
  };
}

// ---- Text alternatives (built from the same data as the drawing) ------------------------

export interface ChartTable {
  head: string[];
  rows: string[][];
}

/** Line chart data as a table: one row per label, one column per series. */
export function seriesTable(
  allSeries: readonly Series[],
  labels: readonly string[],
  labelHeading = 'Date',
): ChartTable {
  const series = drawnSeries(allSeries, labels);
  const count = positions(series, labels);
  return {
    head: [labelHeading, ...series.map((s) => s.name)],
    rows: Array.from({ length: count }, (_, i) => [
      labels[i] ?? String(i + 1),
      ...series.map((s) => (i < s.data.length ? formatNumber(clean(s.data[i])) : '')),
    ]),
  };
}

/** Bars, a donut or a bar list as a table: label, value and (when asked) the share. */
export function datumTable(
  data: readonly Datum[],
  { labelHeading = 'Item', valueHeading = 'Value', shares = false } = {},
): ChartTable {
  const percent = percentages(data.map((d) => d.value));
  return {
    head: shares ? [labelHeading, valueHeading, 'Share'] : [labelHeading, valueHeading],
    rows: data.map((d, i) => {
      const row = [d.label, formatNumber(clean(d.value))];
      return shares ? [...row, `${percent[i] ?? 0}%`] : row;
    }),
  };
}

/**
 * One line naming what a line chart shows, for its accessible name: per series, the
 * highest value and the latest drawn, each with its label.
 */
export function seriesSummary(allSeries: readonly Series[], labels: readonly string[]): string {
  const parts = drawnSeries(allSeries, labels)
    .filter((s) => s.data.length > 0)
    .map((s) => {
      const values = s.data.map(clean);
      const peak = Math.max(...values);
      const at = values.indexOf(peak);
      const last = values.length - 1;
      const label = (i: number) => labels[i] ?? String(i + 1);
      return `${s.name}: highest ${formatNumber(peak)} (${label(at)}), latest ${formatNumber(values[last] ?? 0)} (${label(last)}).`;
    });
  return parts.length > 0 ? parts.join(' ') : 'No data yet.';
}

/** One line for bars or a donut: the largest item (and its share, for a donut). */
export function datumSummary(data: readonly Datum[], { shares = false } = {}): string {
  const values = data.map((d) => clean(d.value));
  const total = values.reduce((a, b) => a + b, 0);
  if (data.length === 0 || total === 0) return 'No data yet.';
  const peak = Math.max(...values);
  const at = values.indexOf(peak);
  const top = data[at]?.label ?? '';
  if (shares) return `Largest: ${top}, ${percentages(values)[at] ?? 0}% of ${formatNumber(total)}.`;
  return `Highest: ${top}, ${formatNumber(peak)}. Total ${formatNumber(total)}.`;
}
