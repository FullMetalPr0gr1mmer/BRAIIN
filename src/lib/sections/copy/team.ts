import type { LocalizedText } from '@schemas/content';

// The pre-UI-v2 team grid (TeamGrid.astro, the `team` type). It takes no content: the people
// are the team table, and these two lines are its fixed labels.

export const TEAM_LABELS = {
  heading: { en: 'The team', ar: 'الفريق' },
  /** Shown while no team member is published. */
  empty: { en: 'Meet the team soon.', ar: 'تعرّف على الفريق قريبًا.' },
} as const satisfies Record<string, LocalizedText>;
