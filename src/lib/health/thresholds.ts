// Site health's thresholds (Admin v2 G2, decision D10), in a module of their own so the
// screens' checklist and the bell read them without the probe runner (which reaches the
// Worker's secrets). The help guide and tests/lib/helpCentre.spec.ts quote them.

const DAY = 24 * 60 * 60 * 1000;

/** The thresholds: the guide and the spec quote these. */
export const THRESHOLDS = {
  /** The domain row fails with this many days or fewer left. */
  domainFailDays: 30,
  /** The certificate row fails with this many days or fewer left. */
  certificateFailDays: 14,
  /** Uptime over 30 days below this percentage warns (on the screen only). */
  uptimeWarnRatio: 99.9,
  /** Failed reads in a row after which a probe reads `unknown` (an hour at 10 minutes). */
  staleAfter: 6,
} as const;

/** Whole days from now until an instant (negative once it has passed). */
export function daysUntil(at: string, now: Date): number {
  return Math.floor((Date.parse(at) - now.getTime()) / DAY);
}
