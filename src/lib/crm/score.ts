import type { LeadInput } from '@schemas/lead';
import { DEFAULT_SCORING, MAX_LEAD_SCORE, type ScoreSignal } from '@schemas/crm';
import { isFreemail } from './normalize';

// A lead's score signals (Admin v2, crm.md §6.3), computed from the plaintext in the
// Worker BEFORE it is encrypted. Only the keys are stored: "a budget was given", never the
// budget. The database adds `returning` (it alone can see earlier leads' indexes) and
// computes the number with app.lead_score, the one definition of the sum.

/** Budget answers that do not count as giving a budget. */
const NO_BUDGET = new Set(['not_sure', 'undisclosed']);

/** The top band, and its legacy spelling from pages cached before the v2 form. */
const TOP_BUDGET = new Set(['gt_200k', 'gt_150k']);

export type SignalInput = Pick<
  LeadInput,
  'serviceOfInterest' | 'budgetBand' | 'company' | 'timelineText' | 'timelineBand'
> & {
  /** The normalised e-mail, or null when it would not normalise. */
  email: string | null;
};

export function leadSignals(input: SignalInput): ScoreSignal[] {
  const signals: ScoreSignal[] = [];
  if (input.serviceOfInterest) signals.push('named_service');
  if (input.budgetBand && !NO_BUDGET.has(input.budgetBand)) signals.push('budget_given');
  if (input.budgetBand && TOP_BUDGET.has(input.budgetBand)) signals.push('budget_200k_plus');
  if (input.email && !isFreemail(input.email)) signals.push('company_email');
  if (input.company && input.company.trim().length > 0) signals.push('company_named');
  if (input.timelineText || input.timelineBand) signals.push('timeline_given');
  return signals;
}

/** The score for a set of signals: the TypeScript twin of app.lead_score (tests hold them equal). */
export function scoreFor(
  signals: readonly ScoreSignal[],
  scoring: Readonly<Partial<Record<ScoreSignal, number>>> = DEFAULT_SCORING,
): number {
  let total = 0;
  for (const signal of new Set(signals)) total += scoring[signal] ?? 0;
  return Math.min(MAX_LEAD_SCORE, total);
}
