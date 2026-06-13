import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROLE_CAPS, CAPABILITIES, type Access, type Capability } from '@/lib/authz/matrix';
import { ROLES, type Role } from '@/lib/auth/types';

// Drift guard: parse the CLAUDE.md §5 role×permission table and assert ROLE_CAPS is
// byte-for-byte consistent with it. The single source of truth must not diverge from
// the documented matrix (CLAUDE.md §5 / architecture.md §3.4).

const LABEL_TO_CAP: Record<string, Capability> = {
  'Users & roles': 'users.manage',
  'General settings (identity, footer, localization)': 'settings.general',
  'Integrations (GA4, Search Console, Calendly, reCAPTCHA)': 'settings.integrations',
  'Maintenance / hidden pages / page visibility': 'maintenance.manage',
  'Theme editor': 'theme.edit',
  'Services — create/edit': 'services.write',
  'Blog — create/edit/autosave': 'blog.write',
  'Portfolio — create/edit': 'portfolio.write',
  'Pages & sections — edit/reorder/style': 'pages.write',
  'Navigation editor': 'nav.edit',
  'Categories management': 'categories.manage',
  'Publish / schedule': 'content.publish',
  'Archive / delete content': 'content.archiveDelete',
  'Per-entity SEO meta / slug / schema': 'seo.entityMeta',
  'Global SEO defaults': 'seo.globalDefaults',
  'Redirects / canonical module': 'redirects.manage',
  'Media — upload / edit metadata': 'media.write',
  'Media — hard delete': 'media.hardDelete',
  'Leads — view list / manage status / notes': 'leads.manage',
  'Leads — budget/timeline/internal_notes/ip (PII)': 'leads.pii',
  'Leads / analytics — export CSV': 'export.csv',
  'Analytics — read dashboards': 'analytics.read',
  'Search analytics': 'analytics.search',
  'AI Style-Finder — questions/styles editor': 'ai.editContent',
  'AI Style-Finder — results/logic config': 'ai.config',
  'System logs — view': 'logs.view',
  'System logs — clear': 'logs.clear',
  'Audit log — view': 'audit.view',
  'Site Health & Performance panel': 'siteHealth.view',
  'Backup export (`export-backup`)': 'export.backup',
};

const ROLE_ORDER: Role[] = ['admin', 'content_creator', 'seo', 'developer'];

function cellToAccess(cell: string): Access {
  const c = cell.trim();
  if (c === '✅') return 'full';
  if (c === '❌') return 'none';
  if (c === 'view') return 'view';
  if (c === 'meta only') return 'meta';
  throw new Error(`Unrecognized matrix cell: "${cell}"`);
}

function parseDocMatrix(): Record<Role, Partial<Record<Capability, Access>>> {
  const md = readFileSync(join(process.cwd(), 'CLAUDE.md'), 'utf8');
  const out: Record<Role, Partial<Record<Capability, Access>>> = {
    admin: {},
    content_creator: {},
    seo: {},
    developer: {},
  };
  for (const line of md.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((s) => s.trim());
    if (cells.length !== 5) continue;
    const label = cells[0]!;
    const cap = LABEL_TO_CAP[label];
    if (!cap) continue; // header / separator / legend rows
    ROLE_ORDER.forEach((role, i) => {
      out[role][cap] = cellToAccess(cells[i + 1]!);
    });
  }
  return out;
}

describe('ROLE_CAPS matches CLAUDE.md §5', () => {
  const doc = parseDocMatrix();

  it('parses all 30 capabilities from the documented table', () => {
    expect(Object.keys(doc.admin).sort()).toEqual([...CAPABILITIES].sort());
  });

  for (const role of ROLES) {
    it(`role '${role}' is byte-for-byte consistent with the doc`, () => {
      for (const cap of CAPABILITIES) {
        expect(ROLE_CAPS[role][cap], `${role}.${cap}`).toBe(doc[role][cap]);
      }
    });
  }

  it('only the four canonical roles exist (anon/other_tenant deny-by-absence)', () => {
    expect([...ROLES].sort()).toEqual(['admin', 'content_creator', 'developer', 'seo']);
  });
});
