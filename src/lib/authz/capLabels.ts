import type { Role } from '@/lib/auth/types';
import { CAPABILITIES, ROLE_CAPS, type Access, type Capability } from './matrix';

// Plain-language lines for the account drawer's "What you can do" (Admin v2 F8,
// docs/admin-v2/ui.md §2.9). Derived from the SAME ROLE_CAPS the server enforces, so the
// list a person reads is the access they have; it is information, never a control (the
// server decides everything, CLAUDE.md §5).
//
// One line per capability and access level. The partial levels ("view", "meta") read as
// what they allow, not as the full right. Copy follows the client's rules (README P-12):
// plain, warm, no em or en dashes, and the studio is never named (it is data, §1).

export interface CapLabel {
  full: string;
  /** For a role holding the capability at 'view' (Content Creator on per-entity SEO). */
  view?: string;
  /** For a role holding it at 'meta' (SEO on media). */
  meta?: string;
}

export const CAP_LABELS: Readonly<Record<Capability, CapLabel>> = {
  'users.manage': { full: 'Invite people and change their roles' },
  'settings.general': { full: 'Edit the site identity, footer and general settings' },
  'settings.integrations': { full: 'Connect analytics, Search Console and other services' },
  'maintenance.manage': { full: 'Turn maintenance mode on and off, and hide pages' },
  'theme.edit': { full: 'Change the theme and how the site looks' },
  'services.write': { full: 'Write and edit services, disciplines and case studies' },
  'blog.write': { full: 'Write and edit Creative Knowledge posts' },
  'portfolio.write': { full: 'Add and edit projects' },
  'pages.write': { full: 'Edit pages and their sections' },
  'nav.edit': { full: 'Edit the menus' },
  'categories.manage': { full: 'Manage categories and sectors' },
  'content.publish': { full: 'Publish and schedule content' },
  'content.archiveDelete': { full: 'Archive and delete content' },
  'seo.entityMeta': {
    full: 'Edit the SEO title, description and link of each page and post',
    view: 'See the SEO settings of each page and post',
  },
  'seo.globalDefaults': { full: 'Edit the site SEO defaults' },
  'redirects.manage': { full: 'Manage redirects' },
  'media.write': {
    full: 'Upload media and edit its details',
    meta: 'Edit image descriptions and alt text',
  },
  'media.hardDelete': { full: 'Delete media for good' },
  'leads.manage': { full: 'See and manage inquiries' },
  'leads.pii': { full: 'See an inquirer’s contact details, one at a time' },
  'export.csv': { full: 'Export inquiries, stats and the activity log as CSV' },
  'crm.erase': { full: 'Erase an inquiry and its notes for good' },
  'crm.settings': { full: 'Set up the pipeline stages, lead scoring, response time and assignment' },
  'applications.manage': { full: 'See and manage job applications' },
  'applications.pii': { full: 'See applicants’ contact details and download CVs' },
  'analytics.read': { full: 'See website stats' },
  'analytics.search': { full: 'See what visitors search for' },
  'ai.editContent': { full: 'Edit the Style-Finder questions and styles' },
  'ai.config': { full: 'Set up the Style-Finder results' },
  'logs.view': { full: 'Read the system logs' },
  'logs.clear': { full: 'Clear the system logs' },
  'audit.view': { full: 'Read the activity log' },
  'siteHealth.view': { full: 'See site health and speed' },
  'export.backup': { full: 'Download a backup of all content' },
};

/** The roles as people read them. */
export const ROLE_LABELS: Readonly<Record<Role, string>> = {
  admin: 'Admin',
  content_creator: 'Content Creator',
  seo: 'SEO',
  developer: 'Developer',
};

/** The line for one capability at one access level, or null when the role has none. */
export function capLine(cap: Capability, access: Access): string | null {
  if (access === 'none') return null;
  const label = CAP_LABELS[cap];
  if (access === 'view') return label.view ?? null;
  if (access === 'meta') return label.meta ?? null;
  return label.full;
}

/** What a role can do, one line per capability it holds, in the matrix's order. */
export function capLinesFor(role: Role): string[] {
  return CAPABILITIES.flatMap((cap) => {
    const line = capLine(cap, ROLE_CAPS[role][cap]);
    return line === null ? [] : [line];
  });
}
