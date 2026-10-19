import { describe, expect, it } from 'vitest';
import { ROLES } from '@/lib/auth/types';
import { CAPABILITIES, ROLE_CAPS } from '@/lib/authz/matrix';
import { CAP_LABELS, ROLE_DESCRIPTIONS, ROLE_LABELS } from '@/lib/authz/capLabels';
import { RoleSchema, UserInviteSchema, UserUpdateSchema } from '@schemas/admin';
import {
  CAP_GROUPS,
  CELL_SPOKEN,
  cellFor,
  groupedCapabilities,
  matrixColumns,
  roleMatrix,
} from '@/lib/authz/roleMatrix';

// The read-only "Roles & permissions" matrix (Admin v2 U12a): generated from ROLE_CAPS, so
// every cell is the access the server enforces, exhaustive over CAPABILITIES and ROLES.

describe('the role matrix', () => {
  it('places every capability in exactly one plain-language group', () => {
    const grouped = groupedCapabilities();
    expect([...grouped].sort()).toEqual([...CAPABILITIES].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
    for (const group of CAP_GROUPS) {
      expect(group.caps.length).toBeGreaterThan(0);
      expect(group.label).not.toMatch(/[–—]/);
    }
  });

  it('renders every role × capability cell from ROLE_CAPS', () => {
    const matrix = roleMatrix();
    const rows = matrix.flatMap((group) => group.rows);
    expect(rows.map((row) => row.cap).sort()).toEqual([...CAPABILITIES].sort());
    for (const row of rows) {
      expect(row.label).toBe(CAP_LABELS[row.cap].full);
      expect(Object.keys(row.cells).sort()).toEqual([...ROLES].sort());
      for (const role of ROLES) expect(row.cells[role]).toBe(cellFor(ROLE_CAPS[role][row.cap]));
    }
  });

  it('says ✓ for full, View and Meta only for the partial levels, — for none', () => {
    expect(cellFor('full')).toBe('✓');
    expect(cellFor('view')).toBe('View');
    expect(cellFor('meta')).toBe('Meta only');
    expect(cellFor('none')).toBe('—');
    const rows = roleMatrix().flatMap((group) => group.rows);
    const at = (cap: string) => rows.find((row) => row.cap === cap)!;
    expect(at('seo.entityMeta').cells.content_creator).toBe('View');
    expect(at('media.write').cells.seo).toBe('Meta only');
    expect(at('users.manage').cells).toEqual({
      admin: '✓',
      content_creator: '—',
      seo: '—',
      developer: '—',
      sales: '—',
    });
  });

  it('reads every symbol aloud as a word', () => {
    expect(CELL_SPOKEN).toEqual({ '✓': 'Yes', View: 'View', 'Meta only': 'Meta only', '—': 'No' });
  });

  it('names a column per role, as people read it, following ROLES', () => {
    expect(matrixColumns()).toEqual(ROLES.map((role) => ({ role, label: ROLE_LABELS[role] })));
    // A role subset (or a new role, once C10a adds Sales) is a column more or fewer.
    expect(roleMatrix(['admin'])[0]?.rows[0]?.cells).toEqual({ admin: '✓' });
  });
});

// Users & roles (Admin v2 C10a): the picker offers every role, each with one plain line.
describe('the roles as Users & roles shows them', () => {
  it('every role has a label and a one-line description, in the copy rules (P-12)', () => {
    for (const role of ROLES) {
      expect(ROLE_LABELS[role], role).toBeTruthy();
      expect(ROLE_DESCRIPTIONS[role], role).toMatch(/^[A-Z].*\.$/);
      expect(ROLE_DESCRIPTIONS[role], role).not.toMatch(/[–—]/);
      expect(ROLE_DESCRIPTIONS[role], role).not.toMatch(/braiin/i);
    }
    expect(ROLE_LABELS.sales).toBe('Sales');
  });

  it('says what Sales is: leads, one lead at a time and logged, no exports', () => {
    expect(ROLE_DESCRIPTIONS.sales).toContain('one lead at a time');
    expect(ROLE_DESCRIPTIONS.sales).toContain('logged');
    expect(ROLE_DESCRIPTIONS.sales).toContain('No content, settings, exports or job applications');
  });

  it('an invite or a role change to Sales passes the schema the users routes read', () => {
    expect(RoleSchema.parse('sales')).toBe('sales');
    expect(UserInviteSchema.parse({ email: 'Sam@Example.com', role: 'sales' })).toMatchObject({
      role: 'sales',
    });
    expect(
      UserUpdateSchema.parse({ userId: '00000000-0000-4000-8000-000000000001', role: 'sales' })
        .role,
    ).toBe('sales');
    expect(RoleSchema.options).toEqual([...ROLES]);
  });
});
