import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROLES } from '@/lib/auth/types';
import { pageFileFor, routeKey, sweepRoutes } from '../admin/routes';
import {
  DIALOG_CASES,
  DIALOG_PRIMITIVES,
  DIALOGS_COVERED_ELSEWHERE,
  LAPTOP,
  PHONE,
  casesFor,
  type Target,
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

/*
 * A screen's markup: its page file and every component, page or layout it imports, followed
 * through `@/` and relative imports (src/lib is left out: the help guides, the palette and the
 * quick actions name controls of other screens, so their words prove nothing about this one).
 */
const UI = /^src\/(?:components|pages|layouts)\//;

function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = `src/${spec.slice(2)}`;
  else if (spec.startsWith('.')) base = join(dirname(from), spec).split(sep).join('/');
  else return null;
  const tries = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];
  return tries.find((path) => /\.(?:tsx?|astro)$/.test(path) && existsSync(path)) ?? null;
}

function screenMarkup(entry: string): string {
  const seen = new Set<string>();
  const todo = [entry];
  const parts: string[] = [];
  while (todo.length > 0) {
    const file = todo.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    parts.push(code(source));
    for (const match of source.matchAll(/\b(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const path = resolveImport(file, match[1]!);
      if (path && UI.test(path)) todo.push(path);
    }
  }
  return parts.join(' ').replace(/\s+/g, ' ');
}

/** The literal accessible names a target is found by (a regex or CSS names none). */
function literalNames(target: Target): string[] {
  const own = 'role' in target && typeof target.name === 'string' ? [target.name] : [];
  return [...own, ...(target.within ? literalNames(target.within) : [])];
}

/**
 * Trigger names the markup builds at run time, so no source spells them out; each traced by
 * hand to where it is made (`<case id>: <name>`).
 */
const BUILT_NAMES: Readonly<Record<string, string>> = {
  'kit-link-dialog: Sample body English':
    'FormField names a rich-text editor by its field label and language',
  'kit-link-dialog: Sample body English formatting':
    'RichText names its toolbar by its editor’s label and “formatting”',
  'service-poster-picker: Poster':
    'MediaField is a fieldset named by its field label (src/lib/admin/ui/services.ts)',
  'seo-new-redirect: New redirect': 'ResourceTable’s button is “New” and the resource’s singular',
  'visibility-drawer: Change who can see Join us':
    'VisibilityList names each row’s button by its page title',
};

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

  it('finds every trigger it names on the case’s own screen (its page and its imports)', () => {
    const fileOf = new Map(
      ROLES.flatMap((role) => sweepRoutes(role).map((r) => [routeKey(r), r.path] as const)),
    );
    const missing: string[] = [];
    const built = new Set<string>();
    for (const c of DIALOG_CASES) {
      const markup = screenMarkup(pageFileFor(fileOf.get(c.screen)!));
      for (const step of c.open) {
        const target = 'click' in step ? step.click : 'press' in step ? step.press : null;
        for (const name of target ? literalNames(target) : []) {
          const key = `${c.id}: ${name}`;
          if (key in BUILT_NAMES) built.add(key);
          else if (!markup.includes(name)) missing.push(`${key} (on ${c.screen})`);
        }
      }
    }
    expect(missing).toEqual([]);
    // Every built name is still a case's trigger: the list cannot outlive what it excuses.
    expect(Object.keys(BUILT_NAMES).filter((key) => !built.has(key))).toEqual([]);
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
