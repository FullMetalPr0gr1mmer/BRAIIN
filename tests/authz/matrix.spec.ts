import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROLE_CAPS, CAPABILITIES, type Access, type Capability } from '@/lib/authz/matrix';
import { ROLES, type Role } from '@/lib/auth/types';

// Drift guard: parse the role×permission table in CLAUDE.md §5 AND in architecture.md §3.4
// (Admin v2 C10a, fixing verification D6: the second was never parsed), and assert ROLE_CAPS
// is byte-for-byte consistent with each. The single source of truth must not diverge from
// either documented matrix. Five roles since C10a (Sales), so a row has six cells.

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
  'Publish / schedule content': 'content.publish',
  'Archive / delete content': 'content.archiveDelete',
  'Per-entity SEO meta / slug / schema': 'seo.entityMeta',
  'Global SEO defaults': 'seo.globalDefaults',
  'Redirects / canonical module': 'redirects.manage',
  'Media — upload / edit metadata': 'media.write',
  'Media — hard delete': 'media.hardDelete',
  'Leads — view list / manage status / notes': 'leads.manage',
  'Leads — budget/timeline/internal_notes/ip (PII)': 'leads.pii',
  'Leads / analytics / activity — export CSV': 'export.csv',
  "Leads & contacts — erase a person's data (DSAR)": 'crm.erase',
  'CRM settings — pipeline stages, scoring, response time, assignment': 'crm.settings',
  'Job applications — view / manage status / notes / erase': 'applications.manage',
  'Job applications — contact details & CV download (PII)': 'applications.pii',
  'Analytics — read dashboards': 'analytics.read',
  'Search analytics': 'analytics.search',
  'Analytics goals — set': 'analytics.goals',
  'AI Style-Finder — questions/styles editor': 'ai.editContent',
  'AI Style-Finder — results/logic config': 'ai.config',
  'System logs — view': 'logs.view',
  'System logs — clear': 'logs.clear',
  'Audit log — view': 'audit.view',
  'Site Health & Performance panel': 'siteHealth.view',
  'Backup export (`export-backup`)': 'export.backup',
};

const ROLE_ORDER: Role[] = ['admin', 'content_creator', 'seo', 'developer', 'sales'];

function cellToAccess(cell: string): Access {
  const c = cell.trim();
  if (c === '✅') return 'full';
  if (c === '❌') return 'none';
  if (c === 'view') return 'view';
  if (c === 'meta only') return 'meta';
  throw new Error(`Unrecognized matrix cell: "${cell}"`);
}

function parseDocMatrix(file: string): Record<Role, Partial<Record<Capability, Access>>> {
  const md = readFileSync(join(process.cwd(), file), 'utf8');
  const out: Record<Role, Partial<Record<Capability, Access>>> = {
    admin: {},
    content_creator: {},
    seo: {},
    developer: {},
    sales: {},
  };
  for (const line of md.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((s) => s.trim());
    const label = cells[0]!;
    const cap = LABEL_TO_CAP[label];
    if (!cap) continue; // header / separator / legend rows
    // A capability row with a cell missing or added is drift too, not a row to skip.
    expect(cells, `${file}: ${label}`).toHaveLength(ROLE_ORDER.length + 1);
    expect(out.admin[cap], `${file}: ${label} appears twice`).toBeUndefined();
    ROLE_ORDER.forEach((role, i) => {
      out[role][cap] = cellToAccess(cells[i + 1]!);
    });
  }
  return out;
}

for (const file of ['CLAUDE.md', 'docs/architecture.md']) {
  describe(`ROLE_CAPS matches the matrix in ${file}`, () => {
    const doc = parseDocMatrix(file);

    it('parses all 35 capabilities from the documented table', () => {
      expect(Object.keys(doc.admin).sort()).toEqual([...CAPABILITIES].sort());
    });

    for (const role of ROLES) {
      it(`role '${role}' is byte-for-byte consistent with the doc`, () => {
        for (const cap of CAPABILITIES) {
          expect(ROLE_CAPS[role][cap], `${role}.${cap}`).toBe(doc[role][cap]);
        }
      });
    }
  });
}

describe('the roles', () => {
  it('the five canonical roles exist, in the documented column order (anon/other_tenant deny-by-absence)', () => {
    expect([...ROLES]).toEqual(ROLE_ORDER);
  });

  it('the two documented matrices are the same table, line for line', () => {
    const rows = (file: string) =>
      readFileSync(join(process.cwd(), file), 'utf8')
        .split(/\r?\n/)
        .filter((line) => {
          const label = line.split('|')[1]?.trim() ?? '';
          return line.startsWith('|') && label in LABEL_TO_CAP;
        });
    expect(rows('docs/architecture.md')).toEqual(rows('CLAUDE.md'));
    expect(rows('CLAUDE.md')).toHaveLength(CAPABILITIES.length);
  });
});

// ── Sales (Admin v2 C10a, owner decision A4) ────────────────────────────────────────────
// Leads, one lead's PII at a time, and the website stats. Everything else is pinned off,
// capability by capability, so a later edit that hands Sales one more fails here by name.
describe('Sales holds leads and the stats, nothing else', () => {
  const SALES_HOLDS: Capability[] = ['leads.manage', 'leads.pii', 'analytics.read'];

  it('holds exactly leads.manage, leads.pii and analytics.read, in full', () => {
    expect(CAPABILITIES.filter((cap) => ROLE_CAPS.sales[cap] !== 'none').sort()).toEqual(
      [...SALES_HOLDS].sort(),
    );
    for (const cap of SALES_HOLDS) expect(ROLE_CAPS.sales[cap]).toBe('full');
  });

  it.each([
    // content
    'services.write',
    'blog.write',
    'portfolio.write',
    'pages.write',
    'nav.edit',
    'categories.manage',
    'content.publish',
    'content.archiveDelete',
    'seo.entityMeta',
    'seo.globalDefaults',
    'redirects.manage',
    'media.write',
    'media.hardDelete',
    'ai.editContent',
    'ai.config',
    // settings and people
    'settings.general',
    'settings.integrations',
    'maintenance.manage',
    'theme.edit',
    'users.manage',
    // exports, backups and erasure: no bulk contact details; nor the CRM's settings
    'export.csv',
    'export.backup',
    'crm.erase',
    'crm.settings',
    // hiring, logs, the activity log, site health, search analytics, the stats' goals
    'applications.manage',
    'applications.pii',
    'logs.view',
    'logs.clear',
    'audit.view',
    'siteHealth.view',
    'analytics.search',
    'analytics.goals',
  ] satisfies Capability[])('never %s', (cap) => {
    expect(ROLE_CAPS.sales[cap]).toBe('none');
  });

  it('the CRM invariants hold for every role: export and erasure imply the PII they reach', () => {
    for (const role of ROLES) {
      if (ROLE_CAPS[role]['export.csv'] === 'full')
        expect(ROLE_CAPS[role]['leads.pii']).toBe('full');
      if (ROLE_CAPS[role]['crm.erase'] === 'full')
        expect(ROLE_CAPS[role]['leads.pii']).toBe('full');
      if (ROLE_CAPS[role]['leads.pii'] === 'full')
        expect(ROLE_CAPS[role]['leads.manage']).toBe('full');
    }
  });
});
