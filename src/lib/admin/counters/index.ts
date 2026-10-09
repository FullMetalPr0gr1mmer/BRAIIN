import { applications } from './applications';
import { leads } from './leads';
import type { Counter } from './types';

export type { Counter } from './types';

// The head counts a sidebar link may carry (`NavLink.count`), one module each (Admin v2
// W0). The shell runs a counter only for a link the role can see (shell.ts). A new count
// is a module here and one line below; a link names it by its key.

export const COUNTERS = {
  applications,
  leads,
} as const satisfies Readonly<Record<string, Counter>>;

/** The key of a registered counter: what a nav link's `count` may name. */
export type NavCount = keyof typeof COUNTERS;
