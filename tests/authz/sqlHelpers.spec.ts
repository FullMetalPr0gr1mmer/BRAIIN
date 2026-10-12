import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROLE_CAPS, type Capability } from '@/lib/authz/matrix';
import { ROLES } from '@/lib/auth/types';

// One SQL helper per capability (Admin v2 CRM design §3.2, migration 0033 onwards):
// `app.role_<name>(r text)` answers "does role r hold this capability?" for RLS. The
// claim "the database mirrors ROLE_CAPS" is only true while someone checks it, so this
// does: the LAST definition of each helper across all migrations must list exactly the
// roles that hold its capability in full. Adding a role (Sales, C10) is then a one-line
// SQL change per helper that this test forces to happen.

const HELPER_CAPABILITY: Record<string, Capability> = {
  role_works_leads: 'leads.manage',
  role_crm_erase: 'crm.erase',
};

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations');

/** helper name → the role list of its last definition. */
function lastDefinitions(): Map<string, string[]> {
  const helpers = new Map<string, string[]>();
  const definition =
    /create\s+or\s+replace\s+function\s+app\.(role_[a-z_]+)\s*\(\s*r\s+text\s*\)[\s\S]*?\$\$([\s\S]*?)\$\$/gi;
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8').replace(/--[^\n]*/g, '');
    for (const [, name, body] of sql.matchAll(definition)) {
      const list = /\bin\s*\(([^)]*)\)/i.exec(body ?? '')?.[1] ?? '';
      helpers.set(name!, [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!).sort());
    }
  }
  return helpers;
}

describe('SQL capability helpers equal ROLE_CAPS', () => {
  const helpers = lastDefinitions();

  it('every helper in the migrations is mapped to a capability, and every mapped one exists', () => {
    expect([...helpers.keys()].sort()).toEqual(Object.keys(HELPER_CAPABILITY).sort());
  });

  for (const [helper, capability] of Object.entries(HELPER_CAPABILITY)) {
    it(`app.${helper} lists exactly the holders of ${capability}`, () => {
      const holders = ROLES.filter((role) => ROLE_CAPS[role][capability] === 'full').sort();
      expect(holders.length).toBeGreaterThan(0);
      expect(helpers.get(helper)).toEqual(holders);
    });
  }
});
