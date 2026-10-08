import type { Access, Capability } from '@/lib/authz/matrix';
import type { NavCount } from '../counters';
import type { IconName } from '../icons';

// The menu's shapes (Admin v2 F2). Each sidebar group is declared by its own module in
// this directory (nav/<area>.ts) and composed in nav/index.ts.

export type { NavCount } from '../counters';

export interface NavTab {
  href: string;
  label: string;
  /** Visible when the role holds ANY of these at `access`. */
  caps: readonly Capability[];
  access?: readonly Access[];
}

export interface NavLink extends NavTab {
  icon: IconName;
  /** Other routes that belong to this area and light its link up. */
  match?: readonly string[];
  /** A head count the shell computes for roles that see the link (src/lib/admin/counters). */
  count?: NavCount;
  /** The area's screens, shown as tabs in its page head when the role sees two or more. */
  tabs?: readonly NavTab[];
}

export interface NavGroup {
  title: string;
  links: readonly NavLink[];
}

/** A sidebar group as its module declares it: the group, plus its place in the menu. */
export interface NavArea extends NavGroup {
  /** The group's position in the sidebar, lowest first. Tens, so an area fits between two. */
  order: number;
}
