import type { Role } from '@/lib/auth/types';
import { ROLE_CAPS, type Capability } from '@/lib/authz/matrix';
import type { IconName } from './icons';

// The quick actions (Admin v2 F3's palette list, docs/admin-v2/ui.md §2.7; U1's dashboard
// library, ui.md §4 "Quick actions editor"). An action NAVIGATES, it never executes: "Add a
// project" opens the create screen, where the server checks the capability again on save.
// Each is offered only to a role that holds its capability in full, so neither the palette
// nor the dashboard ever shows a door the role cannot use.
//
// One library, each action with a stable id (what a person's list and a role's preset store:
// admin_user_prefs.quick_actions, admin_role_defaults.quick_actions, 0060). The palette lists
// the actions that carry a `palette` label, as it did before U1 (tests/lib/adminPalette.spec.ts).
// Only actions whose screen exists today; "change colours", "my tasks" and "publish changes"
// join with E4, C8 and R12.

export interface QuickAction {
  label: string;
  href: string;
  icon: IconName;
  /** Offered when the role holds this capability in full. */
  cap: Capability;
}

export interface LibraryAction {
  /** Stored in a person's list and a role's preset (QUICK_LIBRARY_ID). */
  id: string;
  /** The dashboard's words. */
  label: string;
  /**
   * Where it goes: an admin path, or `home` (the homepage's editor, /admin/pages/<id>, read
   * when the dashboard renders) or `site` (the public site, in a new tab).
   */
  href: string | 'home' | 'site';
  icon: IconName;
  /** Offered when the role holds this capability in full; null for every member. */
  cap: Capability | null;
  /** The palette's words and icon, for the actions the palette lists (F3's, unchanged). */
  palette?: { label: string; icon: IconName };
}

export const QUICK_LIBRARY: readonly LibraryAction[] = [
  { id: 'edit-home', label: 'Edit homepage', href: 'home', icon: 'edit', cap: 'pages.write' },
  {
    id: 'add-service',
    label: 'Add a service',
    href: '/admin/services/new',
    icon: 'layers',
    cap: 'services.write',
    palette: { label: 'New service', icon: 'plus' },
  },
  {
    id: 'add-project',
    label: 'Add a project',
    href: '/admin/portfolio/new',
    icon: 'briefcase',
    cap: 'portfolio.write',
    palette: { label: 'New project', icon: 'plus' },
  },
  {
    id: 'write-post',
    label: 'Write a post',
    href: '/admin/blog/new',
    icon: 'note',
    cap: 'blog.write',
    palette: { label: 'New post', icon: 'plus' },
  },
  {
    id: 'new-page',
    label: 'New page',
    href: '/admin/pages/new',
    icon: 'pages',
    cap: 'pages.write',
    palette: { label: 'New page', icon: 'plus' },
  },
  {
    id: 'add-testimonial',
    label: 'Add a testimonial',
    href: '/admin/testimonials/new',
    icon: 'quote',
    cap: 'portfolio.write',
    palette: { label: 'New testimonial', icon: 'plus' },
  },
  {
    id: 'upload',
    label: 'Upload media',
    // U4: the library with "Choose images" in focus (/admin/media/new redirects there too).
    href: '/admin/media?upload=1',
    icon: 'upload',
    cap: 'media.write',
    palette: { label: 'Upload media', icon: 'upload' },
  },
  {
    id: 'edit-menu',
    label: 'Edit the menu',
    href: '/admin/navigation',
    icon: 'header',
    cap: 'nav.edit',
  },
  { id: 'edit-seo', label: 'Edit SEO', href: '/admin/seo', icon: 'seo', cap: 'seo.globalDefaults' },
  {
    id: 'add-redirect',
    label: 'Add a redirect',
    href: '/admin/redirects/new',
    icon: 'link',
    cap: 'redirects.manage',
    palette: { label: 'New redirect', icon: 'plus' },
  },
  {
    id: 'open-leads',
    label: 'Open leads',
    href: '/admin/leads',
    icon: 'inbox',
    cap: 'leads.manage',
  },
  {
    id: 'stats',
    label: 'Website stats',
    href: '/admin/analytics',
    icon: 'chart',
    cap: 'analytics.read',
  },
  {
    id: 'health',
    label: 'Site health',
    href: '/admin/site-health',
    icon: 'shield',
    cap: 'siteHealth.view',
  },
  {
    id: 'invite',
    label: 'Invite a user',
    href: '/admin/users',
    icon: 'users',
    cap: 'users.manage',
    palette: { label: 'Invite a user', icon: 'users' },
  },
  {
    id: 'maintenance',
    label: 'Maintenance',
    href: '/admin/maintenance',
    icon: 'warn',
    cap: 'maintenance.manage',
  },
  {
    id: 'applications',
    label: 'Job applications',
    href: '/admin/applications',
    icon: 'form',
    cap: 'applications.manage',
  },
  { id: 'view-site', label: 'View site', href: 'site', icon: 'ext', cap: null },
];

const BY_ID = new Map(QUICK_LIBRARY.map((action) => [action.id, action]));

/** A library action by id, or undefined. */
export const libraryAction = (id: string): LibraryAction | undefined => BY_ID.get(id);

/** True when the role may use the action (its capability in full, or none needed). */
export function mayUse(role: Role, action: LibraryAction): boolean {
  return action.cap === null || ROLE_CAPS[role][action.cap] === 'full';
}

/** The library a role may pick from, in the library's order. */
export function libraryFor(role: Role): LibraryAction[] {
  return QUICK_LIBRARY.filter((action) => mayUse(role, action));
}

/**
 * The quick actions a role starts with (the prototype's QUICK_DEFAULT, filtered per role):
 * used when the person never chose and their role has no preset.
 */
export const QUICK_DEFAULTS: Readonly<Record<Role, readonly string[]>> = {
  admin: ['add-service', 'add-project', 'open-leads', 'invite', 'stats', 'edit-home', 'view-site'],
  content_creator: ['add-service', 'add-project', 'write-post', 'upload', 'edit-home', 'view-site'],
  seo: ['edit-seo', 'add-redirect', 'stats', 'view-site'],
  developer: ['open-leads', 'health', 'maintenance', 'upload', 'stats', 'view-site'],
};

const PALETTE: readonly QuickAction[] = QUICK_LIBRARY.flatMap((action) =>
  action.palette && action.cap && action.href.startsWith('/')
    ? [
        {
          label: action.palette.label,
          href: action.href,
          icon: action.palette.icon,
          cap: action.cap,
        },
      ]
    : [],
);

/** The palette's quick actions a role may take, in a stable order (F3). */
export function quickActionsFor(role: Role): QuickAction[] {
  return PALETTE.filter((action) => ROLE_CAPS[role][action.cap] === 'full');
}

/** Every palette action, for tests that check each points at a page that exists. */
export const ALL_QUICK_ACTIONS = PALETTE;
