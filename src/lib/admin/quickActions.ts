import type { Role } from '@/lib/auth/types';
import { ROLE_CAPS, type Capability } from '@/lib/authz/matrix';
import type { IconName } from './icons';

// The command palette's quick actions (Admin v2 F3, docs/admin-v2/ui.md §2.7). An action
// NAVIGATES, it never executes: "New project" opens the create screen, where the server
// checks the capability again on save. Each action is offered only to a role that holds
// its capability in full, so the palette never shows a door the role cannot use.

export interface QuickAction {
  label: string;
  href: string;
  icon: IconName;
  /** Offered when the role holds this capability in full. */
  cap: Capability;
}

const ACTIONS: readonly QuickAction[] = [
  { label: 'New service', href: '/admin/services/new', icon: 'plus', cap: 'services.write' },
  { label: 'New project', href: '/admin/portfolio/new', icon: 'plus', cap: 'portfolio.write' },
  { label: 'New post', href: '/admin/blog/new', icon: 'plus', cap: 'blog.write' },
  { label: 'New page', href: '/admin/pages/new', icon: 'plus', cap: 'pages.write' },
  {
    label: 'New testimonial',
    href: '/admin/testimonials/new',
    icon: 'plus',
    cap: 'portfolio.write',
  },
  { label: 'Upload media', href: '/admin/media/new', icon: 'upload', cap: 'media.write' },
  { label: 'New redirect', href: '/admin/redirects/new', icon: 'plus', cap: 'redirects.manage' },
  { label: 'Invite a user', href: '/admin/users', icon: 'users', cap: 'users.manage' },
];

/** The quick actions a role may take, in a stable order. */
export function quickActionsFor(role: Role): QuickAction[] {
  return ACTIONS.filter((action) => ROLE_CAPS[role][action.cap] === 'full');
}

/** Every action, for tests that check each points at a page that exists. */
export const ALL_QUICK_ACTIONS = ACTIONS;
