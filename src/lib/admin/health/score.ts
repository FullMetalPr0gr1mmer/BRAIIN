import type { CheckState } from './checklist';
import type { Rating } from './vitals';

// The site health score (Admin v2 U2, README D8): half speed, half checklist, the formula
// printed beside the ring. The prototype weighed uptime too; nothing measures uptime here
// yet (owner item O-20), so the score says so rather than inventing a figure.
//
//   speed      the mean over LCP, INP and CLS of good 100, needs work 50, poor 0, counting
//              only measures with enough visits to judge (vitals.ts MIN_SAMPLES);
//   checklist  ok / (ok + fail); info and unknown rows (and rows the role may not check)
//              are left out, so they never pull the score down.
// With no speed to judge the score is the checklist alone, and the formula says that.

export interface HealthScore {
  /** 0 to 100, or null when there is nothing to score. */
  total: number | null;
  vitalsPart: number | null;
  checksPart: number | null;
  /** The sentence printed beside the ring. */
  formula: string;
}

const POINTS: Readonly<Record<Rating, number>> = { good: 100, 'needs-work': 50, poor: 0 };

const UPTIME = 'Uptime is not measured here yet.';

export function healthScore({
  vitals,
  checks,
}: {
  /** The budgeted measures' ratings; null for one without enough visits. */
  vitals: readonly (Rating | null)[];
  checks: readonly { state: CheckState }[];
}): HealthScore {
  const rated = vitals.filter((r): r is Rating => r !== null);
  const vitalsPart =
    rated.length > 0 ? rated.reduce((sum, r) => sum + POINTS[r], 0) / rated.length : null;
  const ok = checks.filter((c) => c.state === 'ok').length;
  const judged = ok + checks.filter((c) => c.state === 'fail').length;
  const checksPart = judged > 0 ? (ok / judged) * 100 : null;

  if (vitalsPart !== null && checksPart !== null) {
    return {
      total: Math.round(vitalsPart / 2 + checksPart / 2),
      vitalsPart,
      checksPart,
      formula: `Speed from real visits (half) and the checklist (half). ${UPTIME}`,
    };
  }
  if (checksPart !== null) {
    return {
      total: Math.round(checksPart),
      vitalsPart: null,
      checksPart,
      formula: `The checklist alone: there are not enough real visits yet to judge speed. ${UPTIME}`,
    };
  }
  if (vitalsPart !== null) {
    return {
      total: Math.round(vitalsPart),
      vitalsPart,
      checksPart: null,
      formula: `Speed from real visits alone: nothing on the checklist could be judged. ${UPTIME}`,
    };
  }
  return {
    total: null,
    vitalsPart: null,
    checksPart: null,
    formula: `Nothing to score yet. ${UPTIME}`,
  };
}

/** The word under the ring: the prototype's three bands. */
export function scoreLabel(total: number | null): string {
  if (total === null) return 'Not scored yet';
  if (total >= 90) return 'Healthy';
  if (total >= 70) return 'Needs attention';
  return 'Problems to fix';
}
