import type { CheckState } from './checklist';
import type { Rating } from './vitals';

// The site health score (Admin v2 U2, README D8; uptime added by G2, decision D11): the
// prototype's healthScore, speed 40%, checklist 40% and uptime 20%, renormalised over the
// parts there are, with the formula printed beside the ring. Without an uptime reading (no
// monitor set up, owner item O-20, or none read just now) it is U2's: half speed, half
// checklist, and the formula says why uptime is left out.
//
//   speed      the mean over LCP, INP and CLS of good 100, needs work 50, poor 0, counting
//              only measures with enough visits to judge (vitals.ts MIN_SAMPLES);
//   checklist  ok / (ok + fail); info and unknown rows (and rows the role may not check)
//              are left out, so they never pull the score down;
//   uptime     the monitor's 30-day uptime: 100% counts in full, 99% or less not at all, in
//              between in proportion ((ratio - 99) x 100: 99.96% gives 96).

export interface HealthScore {
  /** 0 to 100, or null when there is nothing to score. */
  total: number | null;
  vitalsPart: number | null;
  checksPart: number | null;
  /** Null when uptime is not in the score. */
  uptimePart: number | null;
  /** The sentence printed beside the ring. */
  formula: string;
}

/** The parts' weights when all three are there (D11). */
export const SCORE_WEIGHTS = { speed: 40, checks: 40, uptime: 20 } as const;

/** Uptime as the score sees it: a 30-day reading, not set up, or not read just now. */
export type UptimeInput = { ratio30: number } | 'off' | 'unknown';

const POINTS: Readonly<Record<Rating, number>> = { good: 100, 'needs-work': 50, poor: 0 };

/** Why uptime is left out, as the formula's last sentence says it. */
export const UPTIME_OFF = 'Uptime is not set up yet.';
export const UPTIME_UNREAD = 'Uptime could not be read just now.';

/** The monitor's 30-day uptime as points: (ratio - 99) x 100, between 0 and 100. */
export function uptimePoints(ratio30: number): number {
  return Math.min(100, Math.max(0, (ratio30 - 99) * 100));
}

const pct = (weight: number, sum: number) => `${Math.round((weight / sum) * 100)}%`;

export function healthScore({
  vitals,
  checks,
  uptime = 'off',
}: {
  /** The budgeted measures' ratings; null for one without enough visits. */
  vitals: readonly (Rating | null)[];
  checks: readonly { state: CheckState }[];
  /** The uptime reading; not set up when absent. */
  uptime?: UptimeInput | undefined;
}): HealthScore {
  const rated = vitals.filter((r): r is Rating => r !== null);
  const vitalsPart =
    rated.length > 0 ? rated.reduce((sum, r) => sum + POINTS[r], 0) / rated.length : null;
  const ok = checks.filter((c) => c.state === 'ok').length;
  const judged = ok + checks.filter((c) => c.state === 'fail').length;
  const checksPart = judged > 0 ? (ok / judged) * 100 : null;
  const uptimePart = typeof uptime === 'object' ? uptimePoints(uptime.ratio30) : null;

  if (uptimePart !== null) {
    return withUptime(vitalsPart, checksPart, uptimePart);
  }

  // U2's score, word for word, with the reason uptime is left out.
  const why = uptime === 'unknown' ? UPTIME_UNREAD : UPTIME_OFF;
  if (vitalsPart !== null && checksPart !== null) {
    return {
      total: Math.round(vitalsPart / 2 + checksPart / 2),
      vitalsPart,
      checksPart,
      uptimePart: null,
      formula: `Speed from real visits (half) and the checklist (half). ${why}`,
    };
  }
  if (checksPart !== null) {
    return {
      total: Math.round(checksPart),
      vitalsPart: null,
      checksPart,
      uptimePart: null,
      formula: `The checklist alone: there are not enough real visits yet to judge speed. ${why}`,
    };
  }
  if (vitalsPart !== null) {
    return {
      total: Math.round(vitalsPart),
      vitalsPart,
      checksPart: null,
      uptimePart: null,
      formula: `Speed from real visits alone: nothing on the checklist could be judged. ${why}`,
    };
  }
  return {
    total: null,
    vitalsPart: null,
    checksPart: null,
    uptimePart: null,
    formula: `Nothing to score yet. ${why}`,
  };
}

/** The 40 / 40 / 20 score, renormalised over the parts there are (uptime always is). */
function withUptime(
  vitalsPart: number | null,
  checksPart: number | null,
  uptimePart: number,
): HealthScore {
  const W = SCORE_WEIGHTS;
  const sum = (vitalsPart !== null ? W.speed : 0) + (checksPart !== null ? W.checks : 0) + W.uptime;
  const total = Math.round(
    ((vitalsPart ?? 0) * (vitalsPart !== null ? W.speed : 0) +
      (checksPart ?? 0) * (checksPart !== null ? W.checks : 0) +
      uptimePart * W.uptime) /
      sum,
  );
  let formula: string;
  if (vitalsPart !== null && checksPart !== null) {
    formula = `Speed from real visits (${pct(W.speed, sum)}), the checklist (${pct(W.checks, sum)}) and uptime from the monitor (${pct(W.uptime, sum)}).`;
  } else if (checksPart !== null) {
    formula = `The checklist (${pct(W.checks, sum)}) and uptime from the monitor (${pct(W.uptime, sum)}): there are not enough real visits yet to judge speed.`;
  } else if (vitalsPart !== null) {
    formula = `Speed from real visits (${pct(W.speed, sum)}) and uptime from the monitor (${pct(W.uptime, sum)}): nothing on the checklist could be judged.`;
  } else {
    formula =
      'Uptime from the monitor alone: there are not enough real visits yet to judge speed, and nothing on the checklist could be judged.';
  }
  return { total, vitalsPart, checksPart, uptimePart, formula };
}

/** The word under the ring: the prototype's three bands. */
export function scoreLabel(total: number | null): string {
  if (total === null) return 'Not scored yet';
  if (total >= 90) return 'Healthy';
  if (total >= 70) return 'Needs attention';
  return 'Problems to fix';
}
