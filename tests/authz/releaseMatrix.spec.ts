import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROLES, type Role } from '@/lib/auth/types';
import { CONTENT_AREAS, RELEASE_ENTITY_META } from '@/lib/release/areas';
import { canPublish, type ReleaseItemRef } from '@/lib/release/caps';
import { RELEASE_ENTITY_TYPES, type ReleaseEntityType } from '@schemas/release';

// The derived release publish matrix (architecture.md §3.4, Admin v2 R2) equals what
// `requiredCaps` makes of ROLE_CAPS. The table is documentation of a derivation, so it is
// parsed and checked here cell by cell, for every registry type and kind of change in the
// row: a capability change that moves who can publish fails until the table says so, and
// a registry type no row covers fails too. The "Release —" labels keep these rows apart
// from the §5 matrix that tests/authz/matrix.spec.ts parses.

type Kind = 'edit' | 'removal';

const meta = (t: ReleaseEntityType) => RELEASE_ENTITY_META[t];
const isContent = (t: ReleaseEntityType) => CONTENT_AREAS.includes(meta(t).area);

/** Each documented row: the registry types it speaks for and the kinds of change. */
const ROWS: Record<string, { types: ReleaseEntityType[]; kinds: Kind[] }> = {
  'Release — content (pages, sections, services, disciplines, cases, Our work, collections, blog, navigation)':
    { types: RELEASE_ENTITY_TYPES.filter(isContent), kinds: ['edit'] },
  'Release — removals and archives (every area but redirects)': {
    types: RELEASE_ENTITY_TYPES.filter((t) => meta(t).removeCap !== null && t !== 'redirect'),
    kinds: ['removal'],
  },
  'Release — public identity': { types: ['site_profile'], kinds: ['edit'] },
  // P-2 "Theme + header/intro appearance" (the header: Admin v2 E5).
  'Release — theme and appearance': {
    types: ['custom_theme', 'site_appearance'],
    kinds: ['edit'],
  },
  'Release — per-entity SEO': { types: ['entity_seo'], kinds: ['edit'] },
  'Release — global SEO defaults': { types: ['seo_defaults'], kinds: ['edit'] },
  'Release — redirects (removals included)': { types: ['redirect'], kinds: ['edit', 'removal'] },
  'Release — page visibility': { types: ['page_visibility'], kinds: ['edit'] },
};

/**
 * The concrete changes of a kind: create, update, a visible flip and a restore of an archived
 * row; delete, archive, and a change that keeps an archived row archived (hotfix H12).
 */
function items(entityType: ReleaseEntityType, kind: Kind): ReleaseItemRef[] {
  if (kind === 'edit') {
    const out: ReleaseItemRef[] = [
      { entityType, op: 'create' },
      { entityType, op: 'update' },
    ];
    if (meta(entityType).hasStatus) {
      out.push({ entityType, op: 'update', patch: { status: 'published' } });
      out.push({ entityType, op: 'update', patch: { status: 'draft' }, liveStatus: 'archived' });
    }
    if (meta(entityType).publishFlag) {
      out.push({ entityType, op: 'update', patch: { visible: true } });
    }
    return out;
  }
  const out: ReleaseItemRef[] = [{ entityType, op: 'delete' }];
  if (meta(entityType).hasStatus) {
    out.push({ entityType, op: 'update', patch: { status: 'archived' } });
    out.push({ entityType, op: 'update', patch: { sort_order: 5 }, liveStatus: 'archived' });
  }
  return out;
}

const ROLE_ORDER: Role[] = ['admin', 'content_creator', 'seo', 'developer', 'sales'];

function parseReleaseMatrix(): Map<string, boolean[]> {
  const md = readFileSync(join(process.cwd(), 'docs', 'architecture.md'), 'utf8');
  const out = new Map<string, boolean[]>();
  for (const line of md.split('\n')) {
    if (!line.startsWith('| Release —')) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((s) => s.trim());
    expect(cells, line).toHaveLength(ROLE_ORDER.length + 1);
    const values = cells.slice(1).map((cell) => {
      if (cell === '✅') return true;
      if (cell === '❌') return false;
      throw new Error(`unrecognised release matrix cell "${cell}"`);
    });
    expect(out.has(cells[0]!), `duplicate row ${cells[0]}`).toBe(false);
    out.set(cells[0]!, values);
  }
  return out;
}

describe('the release publish matrix (architecture.md §3.4) equals ROLE_CAPS', () => {
  const doc = parseReleaseMatrix();

  it('documents exactly the eight derived rows', () => {
    expect([...doc.keys()].sort()).toEqual(Object.keys(ROWS).sort());
  });

  for (const [label, row] of Object.entries(ROWS)) {
    it(label, () => {
      const cells = doc.get(label)!;
      expect(row.types.length).toBeGreaterThan(0);
      ROLE_ORDER.forEach((role, i) => {
        for (const entityType of row.types) {
          for (const kind of row.kinds) {
            for (const item of items(entityType, kind)) {
              expect(
                canPublish(role, item),
                `${role} · ${entityType} · ${item.op} ${JSON.stringify(item.patch ?? {})}`,
              ).toBe(cells[i]);
            }
          }
        }
      });
    });
  }

  it('covers every registry type: each edit, and each removal a release can make', () => {
    for (const entityType of RELEASE_ENTITY_TYPES) {
      const covering = (kind: Kind) =>
        Object.values(ROWS).filter((r) => r.types.includes(entityType) && r.kinds.includes(kind));
      expect(covering('edit'), `${entityType} edit`).toHaveLength(1);
      expect(covering('removal'), `${entityType} removal`).toHaveLength(
        meta(entityType).removeCap === null ? 0 : 1,
      );
    }
  });

  it('every role is a column, and Sales publishes nothing (P-2: never Sales)', () => {
    expect([...ROLES].sort()).toEqual([...ROLE_ORDER].sort());
    const sales = ROLE_ORDER.indexOf('sales');
    for (const [label, cells] of doc) expect(cells[sales], label).toBe(false);
  });
});
