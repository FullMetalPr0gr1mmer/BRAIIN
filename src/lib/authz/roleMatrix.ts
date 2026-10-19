import type { Role } from '@/lib/auth/types';
import { ROLES } from '@/lib/auth/types';
import { ROLE_CAPS, type Access, type Capability } from './matrix';
import { CAP_LABELS, ROLE_LABELS } from './capLabels';

// The read-only "Roles & permissions" matrix on the users screen (Admin v2 U12a, ui.md
// AV-21). Generated from the SAME ROLE_CAPS the server enforces and the plain-language
// CAP_LABELS, so it can only say what is true; it is information, never a control. Roles are
// fixed (deviations register: no editable matrix, no per-person grants). A role added to
// ROLES (Sales, C10a) appears as a column without a change here.

/** A plain-language group of capabilities: every capability is in exactly one. */
export interface CapGroup {
  label: string;
  caps: readonly Capability[];
}

export const CAP_GROUPS: readonly CapGroup[] = [
  {
    label: 'Content',
    caps: [
      'services.write',
      'blog.write',
      'portfolio.write',
      'pages.write',
      'nav.edit',
      'categories.manage',
      'ai.editContent',
    ],
  },
  { label: 'Publishing', caps: ['content.publish', 'content.archiveDelete'] },
  { label: 'SEO', caps: ['seo.entityMeta', 'seo.globalDefaults', 'redirects.manage'] },
  { label: 'Media', caps: ['media.write', 'media.hardDelete'] },
  {
    label: 'Leads',
    caps: ['leads.manage', 'leads.pii', 'export.csv', 'crm.erase', 'crm.settings'],
  },
  { label: 'Hiring', caps: ['applications.manage', 'applications.pii'] },
  { label: 'Stats', caps: ['analytics.read', 'analytics.search', 'siteHealth.view'] },
  {
    label: 'Settings',
    caps: [
      'settings.general',
      'settings.integrations',
      'maintenance.manage',
      'theme.edit',
      'ai.config',
    ],
  },
  { label: 'People', caps: ['users.manage'] },
  { label: 'Logs and backups', caps: ['logs.view', 'logs.clear', 'audit.view', 'export.backup'] },
];

/** What a cell says: full, a partial level by name, or none. */
export type MatrixCell = '✓' | 'View' | 'Meta only' | '—';

/** A cell read aloud: the symbols are hidden from assistive technology and say these. */
export const CELL_SPOKEN: Readonly<Record<MatrixCell, string>> = {
  '✓': 'Yes',
  View: 'View',
  'Meta only': 'Meta only',
  '—': 'No',
};

export function cellFor(access: Access): MatrixCell {
  switch (access) {
    case 'full':
      return '✓';
    case 'view':
      return 'View';
    case 'meta':
      return 'Meta only';
    default:
      return '—';
  }
}

export interface MatrixRow {
  cap: Capability;
  label: string;
  cells: Record<Role, MatrixCell>;
}

export interface MatrixGroup {
  label: string;
  rows: MatrixRow[];
}

/** The matrix, group by group, one row per capability and one cell per role. */
export function roleMatrix(roles: readonly Role[] = ROLES): MatrixGroup[] {
  return CAP_GROUPS.map((group) => ({
    label: group.label,
    rows: group.caps.map((cap) => ({
      cap,
      label: CAP_LABELS[cap].full,
      cells: Object.fromEntries(
        roles.map((role) => [role, cellFor(ROLE_CAPS[role][cap])]),
      ) as Record<Role, MatrixCell>,
    })),
  }));
}

/** The columns: each role as people read it. */
export function matrixColumns(roles: readonly Role[] = ROLES): { role: Role; label: string }[] {
  return roles.map((role) => ({ role, label: ROLE_LABELS[role] }));
}

/** Every capability, in the groups' order (the test holds it to CAPABILITIES, once each). */
export function groupedCapabilities(): Capability[] {
  return CAP_GROUPS.flatMap((group) => [...group.caps]);
}
