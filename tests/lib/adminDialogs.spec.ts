import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROLES } from '@/lib/auth/types';
import { routeKey, sweepRoutes } from '../admin/routes';
import {
  DIALOG_CASES,
  DIALOG_PRIMITIVES,
  DIALOGS_COVERED_ELSEWHERE,
  LAPTOP,
  PHONE,
  casesFor,
} from '../admin/dialogs';

/*
 * The dialog matrix's registry held complete (Admin v2 Z1). tests/admin/dialogs.e2e.ts opens
 * every case of tests/admin/dialogs.ts for every role that meets it; e2e runs only in CI, so the
 * registry's shape is held here, where a new dialog without a case fails at once:
 *   - every admin source file that renders a dialog is a case's source, a covered-elsewhere
 *     entry, or a primitive;
 *   - every case meets at least one role on a screen its sweep visits;
 *   - every covered-elsewhere spec exists, names its dialog and runs axe.
 */

const ROOTS = ['src/components/admin', 'src/lib/admin', 'src/pages/admin', 'src/layouts'];
const DIALOG = /<(?:Drawer|Modal|ChromeDrawer)\b|<dialog\b|createElement\(\s*['"]dialog['"]\s*\)/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name).replace(/\\/g, '/');
    if (statSync(path).isDirectory()) return files(path);
    return /\.(?:tsx?|astro)$/.test(name) ? [path] : [];
  });
}

/** The code without its comments, so a comment that mentions a <dialog> is not one. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(^|[\s;{}()])\/\/.*$/gm, '$1');
}

const rendering = ROOTS.flatMap(files).filter((path) =>
  DIALOG.test(code(readFileSync(path, 'utf8'))),
);

const named = new Set([
  ...DIALOG_CASES.flatMap((c) => c.sources),
  ...DIALOGS_COVERED_ELSEWHERE.map((e) => e.source),
  ...DIALOG_PRIMITIVES,
]);

describe('the dialog matrix registry (tests/admin/dialogs.ts)', () => {
  it('finds the dialogs it should (the scan is not empty, and sees each kind)', () => {
    expect(rendering).toContain('src/components/admin/kit/Drawer.tsx');
    expect(rendering).toContain('src/components/admin/screens/chrome/CommandPalette.tsx');
    expect(rendering).toContain('src/lib/admin/confirm.ts');
    expect(rendering.length).toBeGreaterThan(40);
    // A comment that mentions a dialog is not one.
    expect(code('// a <dialog> here\nconst x = 1;')).not.toMatch(DIALOG);
    expect(code('/* <Drawer open /> */')).not.toMatch(DIALOG);
  });

  it('names every admin file that renders a dialog: a case, covered elsewhere, or a primitive', () => {
    expect(rendering.filter((path) => !named.has(path))).toEqual([]);
  });

  it('names only files that exist', () => {
    expect([...named].filter((path) => !existsSync(path))).toEqual([]);
  });

  it('gives every case a unique id, a known width, and at least one step', () => {
    const ids = DIALOG_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of DIALOG_CASES) {
      expect(c.open.length, c.id).toBeGreaterThan(0);
      for (const width of c.widths ?? [LAPTOP]) expect([LAPTOP, PHONE], c.id).toContain(width);
    }
  });

  it('meets every case on a screen some role’s sweep visits, for a role that sees it', () => {
    const met = new Set(
      ROLES.flatMap((role) =>
        casesFor(role, new Set(sweepRoutes(role).map(routeKey))).map((c) => c.id),
      ),
    );
    expect(DIALOG_CASES.map((c) => c.id).filter((id) => !met.has(id))).toEqual([]);
  });

  it('opens an edit screen on a named row only through its list API', () => {
    for (const c of DIALOG_CASES.filter((c) => c.slug !== undefined)) {
      expect(c.screen, c.id).toMatch(/\/\[id\]$/);
    }
  });

  it('opens the shell’s dialogs for every role at both widths', () => {
    for (const c of DIALOG_CASES.filter((c) => c.id.startsWith('shell-'))) {
      expect(c.screen, c.id).toBe('/admin');
      for (const role of ROLES) expect(c.who(role), `${c.id} ${role}`).toBe(true);
      expect(c.widths, c.id).toContain(PHONE);
    }
  });

  it('points each dialog covered elsewhere at a spec that opens it with axe', () => {
    for (const entry of DIALOGS_COVERED_ELSEWHERE) {
      expect(existsSync(entry.spec), entry.spec).toBe(true);
      const spec = readFileSync(entry.spec, 'utf8');
      expect(spec, `${entry.spec} names ${entry.marker}`).toContain(entry.marker);
      expect(spec, `${entry.spec} runs axe`).toContain('AxeBuilder');
      expect(rendering, `${entry.source} renders a dialog`).toContain(entry.source);
      expect(entry.roles.length, entry.source).toBeGreaterThan(0);
      expect(entry.why.length, entry.source).toBeGreaterThan(0);
    }
  });
});
