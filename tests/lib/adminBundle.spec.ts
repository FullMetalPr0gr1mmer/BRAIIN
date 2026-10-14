import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { check, closure, dynamicImports, staticImports } from '../../scripts/admin-bundle.mjs';

// scripts/admin-bundle.mjs (Admin v2 F4) reads the built chunks and fails `npm run size`
// when the admin chunk plan breaks. These tests pin how it reads a chunk, and that each
// of its checks fails on the broken layout it exists to catch, using small fixture builds.

function build(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'admin-bundle-'));
  for (const [name, source] of Object.entries(files)) writeFileSync(join(dir, name), source);
  return dir;
}

const GOOD = {
  'client.R1.js': 'import{a}from"./admin-vendor.V1.js";',
  'admin-vendor.V1.js': 'export const a=1;',
  'admin-client.C1.js': 'export const f=1;',
  'admin-ui.U1.js': 'import{f}from"./admin-client.C1.js";const L=()=>import(`./admin-rich.X1.js`);',
  'admin-rich.X1.js': 'export const editor="ProseMirror";',
  'AdminLayout.astro_astro_type_script_index_0_lang.L1.js': 'import"./admin-client.C1.js";',
  'AdminChrome.A1.js': 'import{u}from"./admin-ui.U1.js";',
  'AdminResourceForm.F1.js': 'import{u}from"./admin-ui.U1.js";',
  'login.astro_astro_type_script_index_0_lang.G1.js': 'import{f}from"./admin-client.C1.js";',
  'Hero.astro_astro_type_script_index_0_lang.P1.js': 'import{h}from"./preload-helper.H1.js";',
  'preload-helper.H1.js': 'export const h=1;',
};

describe('reading a chunk', () => {
  it('finds static imports and re-exports, never lazy ones', () => {
    const src =
      'import{a as b}from"./x.js";import"./y.js";export{c}from"./z.js";import(`./lazy.js`);';
    expect(staticImports(src).sort()).toEqual(['x.js', 'y.js', 'z.js']);
    expect(dynamicImports(src)).toEqual(['lazy.js']);
  });

  it('follows static imports transitively', () => {
    const files: Record<string, string> = {
      'a.js': 'import"./b.js";',
      'b.js': 'import"./c.js";import("./d.js");',
      'c.js': '',
      'd.js': '',
    };
    expect([...closure('a.js', (f: string) => files[f] ?? '')].sort()).toEqual([
      'a.js',
      'b.js',
      'c.js',
    ]);
  });
});

describe('the checks', () => {
  it('pass a build that follows the plan', () => {
    expect(check(build(GOOD)).problems).toEqual([]);
  });

  it('fail when an island reaches the editor statically', () => {
    const dir = build({
      ...GOOD,
      'AdminResourceForm.F1.js': 'import"./admin-ui.U1.js";import"./admin-rich.X1.js";',
    });
    expect(check(dir).problems.join('\n')).toMatch(
      /AdminResourceForm\.F1\.js loads admin-rich eagerly/,
    );
  });

  it('fail when a public chunk imports an admin chunk', () => {
    const dir = build({
      ...GOOD,
      'Hero.astro_astro_type_script_index_0_lang.P1.js': 'import{s}from"./admin-ui.U1.js";',
    });
    expect(check(dir).problems.join('\n')).toMatch(/public chunk Hero.* imports admin-ui\.U1\.js/);
  });

  it('count a chunk not named admin-* or Admin* as public, whatever it holds', () => {
    // No island is exempt by name any more (Admin v2 W0): one hydrated under its old name
    // would be weighed against the public budget, and this check says so.
    const dir = build({ ...GOOD, 'LeadsPanel.Q1.js': 'import{u}from"./admin-ui.U1.js";' });
    expect(check(dir).problems.join('\n')).toMatch(
      /public chunk LeadsPanel\.Q1\.js imports admin-ui/,
    );
  });

  it('fail when the editor leaks into admin-ui', () => {
    const dir = build({ ...GOOD, 'admin-ui.U1.js': 'const x="ProseMirror";' });
    expect(check(dir).problems.join('\n')).toMatch(/admin-ui holds ProseMirror/);
  });

  it('fail when the sign-in script outgrows its budget', () => {
    const big = Array.from({ length: 4000 }, (_, i) => `const v${i}=${Math.sin(i)};`).join('');
    const dir = build({ ...GOOD, 'login.astro_astro_type_script_index_0_lang.G1.js': big });
    expect(check(dir).problems.join('\n')).toMatch(/sign-in script loads/);
  });

  it('reports each admin entry with its eager size', () => {
    const report = check(build(GOOD)).report as [string, number][];
    const names = report.map(([name]) => name);
    expect(names).toEqual(
      expect.arrayContaining(['AdminResourceForm', 'AdminChrome', '/admin/login script']),
    );
  });

  it('accept a lazily loaded kit module in admin-kit, and catch it under its own name', () => {
    // An enhancer AdminLayout's script lazy-loads, importing the shared admin code. In the
    // admin-kit chunk (astro.config.mjs) it is admin JavaScript and no island; named after
    // its module, as Rolldown names a lazy chunk no group claims, it is public JavaScript
    // importing admin code.
    const lazy = 'import{f}from"./admin-client.C1.js";const E=()=>import("./admin-kit.K1.js");';
    const kit = build({
      ...GOOD,
      'AdminLayout.astro_astro_type_script_index_0_lang.L1.js': lazy,
      'admin-kit.K1.js': 'import{u}from"./admin-ui.U1.js";export const enhance=1;',
    });
    expect(check(kit).problems).toEqual([]);
    expect((check(kit).report as [string, number][]).map(([name]) => name)).not.toContain(
      'admin-kit',
    );

    const loose = build({
      ...GOOD,
      'AdminLayout.astro_astro_type_script_index_0_lang.L1.js': lazy.replace(
        'admin-kit.K1.js',
        'enhance.E1.js',
      ),
      'enhance.E1.js': 'import{u}from"./admin-ui.U1.js";export const enhance=1;',
    });
    expect(check(loose).problems.join('\n')).toMatch(
      /public chunk enhance\.E1\.js imports admin-ui/,
    );
  });
});

describe('the chunk plan in astro.config.mjs', () => {
  // A group claims the modules its `test` matches (and their static dependencies). Every
  // module of ours under src/{components,lib}/admin/ must be claimed by an admin-* group,
  // so that one reached only through import() still lands in an admin-* file: a chunk
  // named after its module is weighed against the PUBLIC budget. The exceptions are the
  // island entries (Astro names them Admin*) and the reference screen's own code, which
  // only its AdminKit entry reaches.
  interface Group {
    name: string;
    test: RegExp | ((id: string) => boolean);
    priority: number;
  }
  let groups: Group[] = [];

  beforeAll(async () => {
    const config = (await import('../../astro.config.mjs')).default as {
      vite: { build: { rollupOptions: { output: { codeSplitting: { groups: Group[] } } } } };
    };
    groups = [...config.vite.build.rollupOptions.output.codeSplitting.groups].sort(
      (a, b) => b.priority - a.priority,
    );
  });

  /** The group that claims a module: the highest-priority one whose test matches it. */
  const claim = (id: string) =>
    groups.find((g) => (typeof g.test === 'function' ? g.test(id) : g.test.test(id)))?.name;

  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? files(join(dir, entry.name))
        : /\.(ts|tsx)$/.test(entry.name)
          ? [join(dir, entry.name)]
          : [],
    );
  const SELF_NAMED =
    /[\\/]src[\\/]components[\\/]admin[\\/](islands[\\/]Admin\w*\.tsx$|screens[\\/]kit[\\/])/;

  it('names a group for each kind of admin module, the kit last', () => {
    const at = (path: string) => claim(join(process.cwd(), path));
    expect(at('src/lib/admin/client.ts')).toBe('admin-client');
    expect(at('src/lib/admin/pager.ts')).toBe('admin-ui');
    expect(at('src/components/admin/screens/resources/ResourceTable.tsx')).toBe('admin-ui');
    expect(at('src/components/admin/kit/Modal.tsx')).toBe('admin-kit');
    expect(at('src/lib/admin/client/sortable.ts')).toBe('admin-kit');
    // An enhancer that does not exist yet (ui.md §2.1) is claimed the day it is added.
    expect(at('src/lib/admin/client/enhance.ts')).toBe('admin-kit');
    expect(groups.find((g) => g.name === 'admin-kit')?.priority).toBe(
      Math.min(...groups.filter((g) => g.name.startsWith('admin-')).map((g) => g.priority)),
    );
  });

  it('leaves no admin module to a chunk named after itself', () => {
    const roots = ['src/components/admin', 'src/lib/admin'].map((dir) => join(process.cwd(), dir));
    const all = roots.flatMap(files);
    expect(all.length).toBeGreaterThan(100);
    const loose = all
      .filter((id) => !SELF_NAMED.test(id))
      .filter((id) => !claim(id)?.startsWith('admin-'))
      .map((id) => id.slice(process.cwd().length + 1));
    expect(loose).toEqual([]);
  });
});
