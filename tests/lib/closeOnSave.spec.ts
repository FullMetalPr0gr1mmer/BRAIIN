import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { editLanded } from '@/lib/admin/closeOnSave';
import { entitySaveReducer, initialSaveState } from '@/lib/admin/entitySave';
import type { FieldDef } from '@/lib/admin/uiSchema';

// Admin v2 R14d: a drawer that closes once an edit lands closes only on the person's own save.
// In release mode an editor saves by itself when focus leaves a field it changed (P-5), and the
// collection, discipline, sector and redirect drawers closed on that first automatic save:
// typing a question and moving to its answer closed the FAQ drawer. Found converting the
// collections spec to release mode. Releases off nothing saves by itself, so nothing changes.

const FIELDS: FieldDef[] = [{ name: 'slug', label: 'Slug', kind: 'text' }];
const ROW = { id: 'r1', slug: 'logo', version: 4, draft: null };

const loaded = () =>
  entitySaveReducer(initialSaveState(FIELDS, false), {
    type: 'loaded',
    row: ROW,
    fields: FIELDS,
    versionFallback: 1,
  });

describe('whose save landed (entitySave.ts savedByPerson)', () => {
  it('nothing has landed yet: no save is the person’s', () => {
    expect(initialSaveState(FIELDS, false).savedByPerson).toBe(false);
  });

  it('a save says whose it was; one that does not say is the person’s (live mode)', () => {
    const at = '2026-11-07T10:00:00Z';
    const auto = entitySaveReducer(loaded(), {
      type: 'saved',
      row: { ...ROW, version: 4, draft: { id: 'd1', version: 1, op: 'update' } },
      fields: FIELDS,
      at,
      byPerson: false,
    });
    expect(auto.savedByPerson).toBe(false);
    expect(auto.savedAt).toBe(at);
    const theirs = entitySaveReducer(auto, {
      type: 'saved',
      row: ROW,
      fields: FIELDS,
      at,
      byPerson: true,
    });
    expect(theirs.savedByPerson).toBe(true);
    const unsaid = entitySaveReducer(auto, { type: 'saved', row: ROW, fields: FIELDS, at });
    expect(unsaid.savedByPerson).toBe(true);
  });
});

describe('editLanded (closeOnSave.ts)', () => {
  it('closes on a save that landed since the drawer opened, when it was the person’s', () => {
    expect(editLanded('b', 'a', true)).toBe(true);
    // A hand-built save that does not say (a test's, a screen's own) is the person's.
    expect(editLanded('b', 'a', undefined)).toBe(true);
    expect(editLanded('b', null, true)).toBe(true);
  });

  it('never on an automatic save, nor before anything landed, nor on the opening value', () => {
    expect(editLanded('b', 'a', false)).toBe(false);
    expect(editLanded(null, null, true)).toBe(false);
    expect(editLanded('a', 'a', true)).toBe(false);
  });
});

describe('the wiring', () => {
  const read = (path: string) => readFileSync(path, 'utf8');

  it('every drawer that closes on a landed edit asks editLanded with savedByPerson', () => {
    for (const path of [
      'src/components/admin/screens/collection/CollectionDrawer.tsx',
      'src/components/admin/screens/projects/TagsDrawer.tsx',
      'src/components/admin/screens/services/DisciplineDrawer.tsx',
      'src/components/admin/screens/seo/RedirectsTab.tsx',
    ]) {
      expect(read(path), path).toMatch(/editLanded\([^)]*save\.savedByPerson\)/);
    }
  });

  it('no other admin screen closes on a landed save without the gate', () => {
    // Every component that remembers the opening `savedAt` (the close-on-save shape) uses it.
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? walk(`${dir}/${e.name}`)
          : e.name.endsWith('.tsx')
            ? [`${dir}/${e.name}`]
            : [],
      );
    const closers = walk('src/components').filter((path) =>
      /firstSavedAt|editLanded\(|done\.current\(save\.edgeMissed\)/.test(read(path)),
    );
    expect(closers.sort()).toEqual(
      [
        'src/components/admin/screens/collection/CollectionDrawer.tsx',
        'src/components/admin/screens/projects/TagsDrawer.tsx',
        'src/components/admin/screens/seo/RedirectsTab.tsx',
        'src/components/admin/screens/services/DisciplineDrawer.tsx',
      ].sort(),
    );
    for (const path of closers) {
      expect(read(path), path).toMatch(/editLanded\([^)]*save\.savedByPerson\)/);
      expect(read(path), path).not.toMatch(/savedAt && (save\.)?savedAt !== firstSavedAt/);
    }
  });

  it('the hook says whose save landed: the person’s, or an automatic one that answered a press', () => {
    const hook = read('src/lib/admin/useEntitySave.ts');
    // A press while a save is on its way is remembered; any press is.
    expect(hook).toMatch(
      /if \(inFlight\.current\) \{\s*again\.current = true;\s*if \(!auto\) wanted\.current = true;/,
    );
    expect(hook).toMatch(/if \(!auto\) wanted\.current = true;\s*let request/);
    // The landing: the person's own, or the automatic one when nothing was typed since.
    expect(hook).toContain('const byPerson = !auto || (wanted.current && !typedSince);');
    expect(hook).toMatch(/dispatch\(\{ type: 'saved', row, fields, at: [^}]*, byPerson \}\)/);
    // A press the landing did not answer becomes the person's own save.
    expect(hook).toMatch(/if \(wanted\.current\) void run\(false\);\s*else flush\(\);/);
    // A refusal answers the press.
    expect(hook).toMatch(/catch \(err\) \{\s*\/\/[^\n]*\n\s*wanted\.current = false;/);
    expect(hook).toContain('savedByPerson: state.savedByPerson,');
  });
});
