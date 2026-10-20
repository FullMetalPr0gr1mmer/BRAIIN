import type { AssignmentRule, ScoreSignal, StageKind, StageTone } from '@schemas/crm';

// The words of the CRM settings screen (Admin v2 C9a), in one place so the screen and its
// tests read the same copy. The client's rules (README P-12): plain, warm, no em or en dashes,
// the studio never named.
//
// The screen's limits and closed lists are here too, not imported from @schemas/crm at run
// time: that module is the leads screens' (the admin-leads chunk group claims it), and a
// static import from this screen's chunk would make every screen in admin-screens load the
// leads chunk (scripts/admin-bundle.mjs refuses it). tests/lib/crmSettings.spec.ts holds every
// value here equal to the schema's. Types are imported, which costs nothing at run time.

/** The limits the schema and the database hold (packages/schemas/crm.ts, 0034, 0035, 0091). */
export const LIMITS = {
  minStages: 2,
  maxStages: 10,
  maxLabel: 40,
  maxPoints: 50,
  maxScore: 100,
  maxPool: 20,
  minSla: 1,
  maxSla: 168,
} as const;

/** Every scoring signal, in the schema's order (the save sends the whole set). */
export const ALL_SIGNALS: readonly ScoreSignal[] = [
  'named_service',
  'budget_given',
  'budget_200k_plus',
  'company_email',
  'company_named',
  'timeline_given',
  'returning',
  'service_page',
];

/** A tone by its name, in the palette's order: chosen by name, never by colour alone. */
export const TONE_NAMES: Readonly<Record<StageTone, string>> = {
  klein: 'Blue',
  sky: 'Sky',
  ok: 'Green',
  warn: 'Amber',
  err: 'Red',
  gray: 'Grey',
};

export const KIND_NAMES: Readonly<Record<StageKind, string>> = {
  open: 'Open',
  won: 'Won',
  lost: 'Lost',
};

export const TONES = Object.keys(TONE_NAMES) as StageTone[];
export const KINDS = Object.keys(KIND_NAMES) as StageKind[];

/**
 * The signals the screen offers, in the prototype's order of weight, with what each means.
 * `service_page` is not offered: it is set only once attribution ships (C13), and its points
 * are kept as they are until then.
 */
export const SIGNAL_COPY: readonly { signal: ScoreSignal; label: string; hint: string }[] = [
  {
    signal: 'budget_200k_plus',
    label: 'Budget over 200k',
    hint: 'They chose the top budget band.',
  },
  { signal: 'budget_given', label: 'Gave a budget', hint: 'Any budget but "not sure".' },
  {
    signal: 'named_service',
    label: 'Asked about a service',
    hint: 'They picked a service on the form.',
  },
  {
    signal: 'company_email',
    label: 'Company e-mail',
    hint: 'Not Gmail, Outlook or another free address.',
  },
  { signal: 'returning', label: 'Came back', hint: 'Their e-mail reached us before.' },
  { signal: 'company_named', label: 'Named a company', hint: 'The company field is filled in.' },
  { signal: 'timeline_given', label: 'Gave a timeline', hint: 'They said when they need it.' },
];

export const RULE_COPY: readonly { rule: AssignmentRule; label: string; hint: string }[] = [
  { rule: 'manual', label: 'Manual', hint: 'New leads wait for someone to pick them up.' },
  {
    rule: 'round_robin',
    label: 'Round robin',
    hint: 'Each new lead goes to the next person in the rotation.',
  },
  { rule: 'fixed', label: 'Always to one person', hint: 'Every new lead goes to them.' },
];

/** A count of leads in words: "1 lead", "3 leads". */
export function leadsCount(n: number): string {
  return n === 1 ? '1 lead' : `${n} leads`;
}

/** Why a stage cannot be removed, or null when it can. */
export function removeBlocked(stage: { is_initial?: boolean; leads?: number }): string | null {
  if (stage.is_initial) return 'Every new lead starts here, so it stays.';
  const n = stage.leads ?? 0;
  return n > 0 ? `Move its ${leadsCount(n)} first.` : null;
}
