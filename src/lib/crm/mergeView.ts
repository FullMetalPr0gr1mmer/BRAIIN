import type { DuplicatePair, DuplicateReason, DuplicateSide } from '@schemas/crmMerge';

// The Merge duplicates screen's words (Admin v2 C12, crm.md §11 screen 9): pure, for the
// island and its tests. Each pair says why it was offered and what a merge would move, in
// counts; never an e-mail, a phone or a note (crm.md §11 PII rules: "merge pairs").

/** A reason in words (P-12: plain, no dashes). Never the value that matched. */
export const REASON_WORDS: Readonly<Record<DuplicateReason, string>> = {
  phone: 'Same phone number',
  name_company: 'Same name at the same company',
};

/** The reasons of a pair as one line: "Same phone number. Same name at the same company." */
export function reasonLine(reasons: readonly DuplicateReason[]): string {
  return reasons.map((reason) => `${REASON_WORDS[reason]}.`).join(' ');
}

/**
 * Which of the two to keep by default: the older record (crm.md §11 screen 9, "Merge into
 * older"), the first-listed when they were made at the same instant.
 */
export function olderFirst(pair: DuplicatePair): { keep: DuplicateSide; drop: DuplicateSide } {
  const a = Date.parse(pair.a.created_at);
  const b = Date.parse(pair.b.created_at);
  return Number.isFinite(b) && (!Number.isFinite(a) || b < a)
    ? { keep: pair.b, drop: pair.a }
    : { keep: pair.a, drop: pair.b };
}

const n = (value: number, one: string, many: string) => `${value} ${value === 1 ? one : many}`;

/**
 * What moves, in words, for the preview: "Their 2 leads, 1 e-mail address and 1 phone number,
 * notes, tasks and timeline move to Sara Ali." Counts only, never a value.
 */
export function movesLine(drop: DuplicateSide): string {
  const parts = [n(drop.leads, 'lead', 'leads')];
  if (drop.emails > 0) parts.push(n(drop.emails, 'e-mail address', 'e-mail addresses'));
  if (drop.phones > 0) parts.push(n(drop.phones, 'phone number', 'phone numbers'));
  return `Their ${parts.join(', ')}, notes, tasks and timeline move.`;
}
