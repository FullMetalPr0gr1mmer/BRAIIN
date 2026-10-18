import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
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

  it('weighs every sign-in screen and their shell, not only login (Admin v2 F7)', () => {
    const big = Array.from({ length: 4000 }, (_, i) => `const v${i}=${Math.sin(i)};`).join('');
    for (const name of [
      'forgot.astro_astro_type_script_index_0_lang.Z1.js',
      'reset.astro_astro_type_script_index_0_lang.Z1.js',
      'invite.astro_astro_type_script_index_0_lang.Z1.js',
      'AuthLayout.astro_astro_type_script_index_0_lang.Z1.js',
    ]) {
      const result = check(build({ ...GOOD, [name]: big }));
      expect(result.problems.join('\n'), name).toMatch(/sign-in script loads/);
      // A sign-in chunk is admin code, not a public chunk importing one.
      const imports = check(build({ ...GOOD, [name]: 'import"./admin-client.C1.js";' }));
      expect(imports.problems, name).toEqual([]);
    }
  });

  it('reports a zero-JS sign-in as 0 B (F7: the screens are plain forms)', () => {
    const { 'login.astro_astro_type_script_index_0_lang.G1.js': _login, ...noScript } = GOOD;
    const { problems, report } = check(build(noScript)) as {
      problems: string[];
      report: [string, number][];
    };
    expect(problems).toEqual([]);
    expect(report).toContainEqual(['sign-in screens script (login, forgot, reset, invite)', 0]);
  });

  it('reports each admin entry with its eager size', () => {
    const report = check(build(GOOD)).report as [string, number][];
    const names = report.map(([name]) => name);
    expect(names).toEqual(
      expect.arrayContaining([
        'AdminResourceForm',
        'AdminChrome',
        'sign-in screens script (login, forgot, reset, invite)',
      ]),
    );
  });

  it('fail when admin-ui imports a group meant for some screens only (Admin v2 U4)', () => {
    for (const group of ['admin-fields.F2.js', 'admin-screens.S2.js', 'admin-dashboard.D2.js']) {
      const dir = build({
        ...GOOD,
        'admin-ui.U1.js': `import"./${group}";const L=()=>import("./admin-rich.X1.js");`,
        [group]: 'export const x=1;',
      });
      expect(check(dir).problems.join('\n'), group).toMatch(
        new RegExp(`admin-ui imports ${group.replace(/\./g, '\.')} statically`),
      );
    }
    // Lazily, it may: that is how a screen's editing pieces load on first use.
    const lazy = build({
      ...GOOD,
      'admin-ui.U1.js':
        'const L=()=>import(`./admin-rich.X1.js`);const M=()=>import("./admin-dashboard.D2.js");',
      'admin-dashboard.D2.js': 'export const x=1;',
    });
    expect(check(lazy).problems).toEqual([]);
  });

  it('catch admin code under a module name: a chunk only admin chunks load (Wave 3 rule 7)', () => {
    // A screen module no group claims, reached through import(), becomes `usage-<hash>.js`:
    // size-limit weighs it as public JavaScript, and nothing imports admin code from it, so
    // check 2 alone would not see it.
    const loose = build({
      ...GOOD,
      'admin-screens.S1.js': 'import"./admin-ui.U1.js";const U=()=>import("./usage.Q1.js");',
      'AdminMediaLibrary.M1.js': 'import"./admin-screens.S1.js";',
      'usage.Q1.js': 'export const u=1;',
    });
    expect(check(loose).problems.join('\n')).toMatch(
      /usage\.Q1\.js is loaded only by admin chunks \(admin-screens\.S1\.js\) but is not named admin-\*/,
    );
    // Claimed by a group, it is admin code by name; shared with a public chunk, it is not
    // admin code at all; the bundler's runtime helpers are neither.
    const claimed = build({
      ...GOOD,
      'admin-screens.S1.js': 'import"./admin-ui.U1.js";',
      'AdminMediaLibrary.M1.js': 'import"./admin-screens.S1.js";',
    });
    expect(check(claimed).problems).toEqual([]);
    const shared = build({
      ...GOOD,
      'admin-ui.U1.js': 'import"./shared.Z1.js";const L=()=>import(`./admin-rich.X1.js`);',
      'Hero.astro_astro_type_script_index_0_lang.P1.js': 'import"./shared.Z1.js";',
      'shared.Z1.js': 'export const z=1;',
      'rolldown-runtime.R1.js': 'export const r=1;',
      'admin-vendor.V1.js': 'import"./rolldown-runtime.R1.js";export const a=1;',
    });
    expect(check(shared).problems).toEqual([]);
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
  // The dashboard's island code (U1) stays in its AdminDashboard entry, as the kit screen's.
  const SELF_NAMED =
    /[\\/]src[\\/]components[\\/]admin[\\/](islands[\\/]Admin\w*\.tsx$|screens[\\/]kit[\\/]|screens[\\/]dashboard[\\/](Dashboard\.tsx|types\.ts)$)/;

  it('names a group for each kind of admin module, the kit last', () => {
    const at = (path: string) => claim(join(process.cwd(), path));
    expect(at('src/lib/admin/client.ts')).toBe('admin-client');
    expect(at('src/lib/admin/pager.ts')).toBe('admin-ui');
    expect(at('src/components/admin/screens/resources/ResourceTable.tsx')).toBe('admin-ui');
    expect(at('src/components/admin/kit/Modal.tsx')).toBe('admin-kit');
    expect(at('src/lib/admin/client/sortable.ts')).toBe('admin-kit');
    // An enhancer that does not exist yet (ui.md §2.1) is claimed the day it is added.
    expect(at('src/lib/admin/client/enhance.ts')).toBe('admin-kit');
    // The two models only kit code reaches in the browser ride with the kit, not on every
    // screen; their neighbours stay admin-ui's (f4b pre-merge review).
    expect(at('src/lib/admin/roving.ts')).toBe('admin-kit');
    expect(at('src/lib/admin/avatar.ts')).toBe('admin-kit');
    expect(at('src/lib/admin/initials.ts')).toBe('admin-ui');
    expect(at('src/lib/admin/relTime.ts')).toBe('admin-ui');
    // The dashboard's editing pieces load on first use, never on another screen (U1).
    expect(at('src/components/admin/screens/dashboard/QuickActionsDrawer.tsx')).toBe(
      'admin-dashboard',
    );
    expect(at('src/components/admin/screens/dashboard/customize.ts')).toBe('admin-dashboard');
    expect(at('src/components/admin/screens/dashboard/Dashboard.tsx')).toBeUndefined();
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

describe('the screens admin-ui leaves share one admin-screens group (Admin v2 U4)', () => {
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
  const claim = (path: string) => {
    const id = join(process.cwd(), path);
    return groups.find((g) => (typeof g.test === 'function' ? g.test(id) : g.test.test(id)))?.name;
  };

  it('claims the media library island and its screen code, by path', () => {
    for (const path of [
      'src/components/admin/islands/AdminMediaLibrary.tsx',
      'src/components/admin/screens/media/MediaLibrary.tsx',
      'src/components/admin/screens/media/MediaDrawer.tsx',
      'src/components/admin/screens/media/usage.ts',
      // A module a later change adds there, lazily loaded or not, joins with no config edit.
      'src/components/admin/screens/media/NotWrittenYet.tsx',
    ]) {
      expect(claim(path), path).toBe('admin-screens');
    }
    // The picker, the grid and the upload dialog are the field kit's (every editor).
    expect(claim('src/components/admin/fields/media/MediaPicker.tsx')).toBe('admin-fields');
    expect(claim('src/components/admin/fields/media/UploadDialog.tsx')).toBe('admin-fields');
  });

  it('leaves every other screen where it was', () => {
    expect(claim('src/components/admin/screens/users/UsersPanel.tsx')).toBe('admin-ui');
    expect(claim('src/components/admin/islands/AdminUsers.tsx')).toBe('admin-ui');
    expect(claim('src/components/admin/islands/AdminResourceForm.tsx')).toBeUndefined();
    expect(claim('src/components/admin/islands/AdminSingletonForm.tsx')).toBeUndefined();
    expect(claim('src/components/admin/islands/AdminKit.tsx')).toBeUndefined();
    expect(claim('src/components/admin/islands/AdminDashboard.tsx')).toBeUndefined();
    expect(claim('src/components/admin/screens/dashboard/QuickActionsDrawer.tsx')).toBe(
      'admin-dashboard',
    );
  });

  it('sits below the field kit, so what both use stays in admin-fields', () => {
    const priority = (name: string) => groups.find((g) => g.name === name)!.priority;
    expect(priority('admin-screens')).toBeLessThan(priority('admin-fields'));
    expect(priority('admin-screens')).toBeGreaterThan(priority('admin-kit'));
  });

  it('names the editor islands and screen directories one a line, sorted', () => {
    const config = readFileSync(join(process.cwd(), 'astro.config.mjs'), 'utf8').replace(
      /\r\n/g,
      '\n',
    );
    for (const name of ['ADMIN_EDITOR_ISLAND_NAMES', 'ADMIN_EDITOR_SCREEN_DIRS']) {
      const start = config.indexOf(`const ${name} = [\n`);
      const body =
        start < 0
          ? undefined
          : config.slice(start + `const ${name} = [\n`.length, config.indexOf('\n];', start));
      expect(body, name).toBeDefined();
      const lines = body!.split('\n');
      expect(
        lines.every((line) => /^ {2}'[A-Za-z]+',$/.test(line)),
        name,
      ).toBe(true);
      expect([...lines].sort(), name).toEqual(lines);
    }
  });
});

describe('the field kit is its own group (Admin v2 F5a)', () => {
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
  const claim = (path: string) => {
    const id = join(process.cwd(), path);
    return groups.find((g) => (typeof g.test === 'function' ? g.test(id) : g.test.test(id)))?.name;
  };

  it('claims the field kit, the save machine and the two editors for admin-fields', () => {
    for (const path of [
      'src/components/admin/FormField.tsx',
      'src/components/admin/fields/EditorForm.tsx',
      'src/components/admin/fields/RepeaterField.tsx',
      'src/components/admin/screens/resources/ResourceForm.tsx',
      'src/components/admin/screens/singleton/SingletonForm.tsx',
      'src/lib/admin/formPayload.ts',
      'src/lib/admin/sectionUi.ts',
      'src/lib/admin/useEntitySave.ts',
      'src/lib/admin/entitySave.ts',
      'src/lib/admin/fieldErrors.ts',
    ]) {
      expect(claim(path), path).toBe('admin-fields');
    }
    // The list beside the form, and the editor itself, keep their groups.
    expect(claim('src/components/admin/screens/resources/ResourceTable.tsx')).toBe('admin-ui');
    expect(claim('src/components/admin/RichText.tsx')).toBe('admin-rich');
    // The editor islands are left to their entry chunks: admin-ui's path rule matched them,
    // and a group takes its modules' dependencies, so it took the whole field kit along.
    expect(claim('src/components/admin/islands/AdminResourceForm.tsx')).toBeUndefined();
    expect(claim('src/components/admin/islands/AdminSingletonForm.tsx')).toBeUndefined();
    const priority = (name: string) => groups.find((g) => g.name === name)!.priority;
    expect(priority('admin-fields')).toBeLessThan(priority('admin-ui'));
    expect(priority('admin-fields')).toBeGreaterThan(priority('admin-kit'));
  });

  it('no module admin-ui claims imports one of admin-fields (it would pull it back)', () => {
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? files(join(dir, entry.name))
          : /\.(ts|tsx)$/.test(entry.name)
            ? [join(dir, entry.name)]
            : [],
      );
    const root = process.cwd();
    const all = ['src/components/admin', 'src/lib/admin'].flatMap((d) => files(join(root, d)));
    const rel = (abs: string) =>
      abs
        .slice(root.length + 1)
        .split(sep)
        .join('/');
    const resolve = (from: string, spec: string): string | null => {
      const base = spec.startsWith('@/')
        ? `src/${spec.slice(2)}`
        : spec.startsWith('.')
          ? join(from, '..', spec)
              .slice(root.length + 1)
              .split(sep)
              .join('/')
          : null;
      if (!base) return null;
      for (const ext of ['', '.ts', '.tsx']) {
        if (all.some((f) => rel(f) === base + ext)) return base + ext;
      }
      return null;
    };
    const offenders: string[] = [];
    for (const file of all) {
      if (claim(rel(file)) !== 'admin-ui') continue;
      const source = readFileSync(file, 'utf8');
      // Static, value imports only: `import type` is erased, `import()` is lazy.
      for (const m of source.matchAll(/^import\s+(?!type\b)[^;]*?from\s*['"]([^'"]+)['"]/gm)) {
        const target = resolve(file, m[1] as string);
        if (target && claim(target) === 'admin-fields') offenders.push(`${rel(file)} → ${target}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
