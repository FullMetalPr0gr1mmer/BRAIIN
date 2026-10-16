// A KPI's change against the previous period (Admin v2 F4b, docs/admin-v2/ui.md §2.4): the
// prototype's delta pill (▲ up, ▼ down, • flat). Shared by Kpi.astro and the dashboard and
// stats slices that compute the numbers.
//
// The arrow says the direction and the colour says whether that is good, so a KPI where
// fewer is better (errors, response time) passes `good: 'down'` and a fall reads green.
// Neither is the only cue: the pill's words carry both ("down 12%, vs the previous 7
// days"), for a screen reader and in forced colours alike.

export type Trend = 'up' | 'down' | 'flat';

export interface DeltaView {
  trend: Trend;
  /** The pill's tone: `ok` when the change is the good way, `err` when not, else `flat`. */
  tone: 'ok' | 'err' | 'flat';
  glyph: '▲' | '▼' | '•';
  /** What the pill shows: "12%". */
  text: string;
  /** What a screen reader hears before the period: "up 12%". */
  spoken: string;
}

const PERCENT = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });

/**
 * The change from `previous` to `current` in percent, or null when there is nothing to
 * compare with (no previous period, or a previous value of zero, where any change is
 * infinite). A KPI with a null change shows no pill: "not enough history" is not a trend.
 */
export function percentChange(current: number, previous: number | null | undefined) {
  if (typeof previous !== 'number' || !Number.isFinite(previous) || previous <= 0) return null;
  if (!Number.isFinite(current)) return null;
  return ((current - previous) / previous) * 100;
}

/**
 * What a change is measured in: `percent` of the previous value (page views up 12%), or
 * percentage `points` for a figure that is itself a share (the Arabic share from 10% to 20%
 * is "up 10 points", not "up 100%"; U2).
 */
export type DeltaUnit = 'percent' | 'points';

/** The change in percentage points between two shares, or null without a previous one. */
export function pointChange(current: number | null, previous: number | null | undefined) {
  if (current === null || typeof previous !== 'number') return null;
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  return current - previous;
}

/** How the pill reads for a change in percent (or points); null draws no pill. */
export function deltaView(
  delta: number | null | undefined,
  good: 'up' | 'down' = 'up',
  unit: DeltaUnit = 'percent',
): DeltaView | null {
  if (typeof delta !== 'number' || !Number.isFinite(delta)) return null;
  const size = Math.round(Math.abs(delta));
  const text =
    unit === 'points'
      ? `${PERCENT.format(size)} ${size === 1 ? 'point' : 'points'}`
      : `${PERCENT.format(size)}%`;
  if (size === 0) return { trend: 'flat', tone: 'flat', glyph: '•', text, spoken: `no change` };
  const trend: Trend = delta > 0 ? 'up' : 'down';
  return {
    trend,
    tone: trend === good ? 'ok' : 'err',
    glyph: trend === 'up' ? '▲' : '▼',
    text,
    spoken: `${trend} ${text}`,
  };
}
