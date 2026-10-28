import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, parseSync, type Plugin, type Rolldown } from 'vite';
import {
  annotateZodCalls,
  assertZodMajor,
  installedZodVersion,
  SCHEMA_MODULE,
  zodPurePlugin,
} from '../../scripts/zod-pure.mjs';

// scripts/zod-pure.mjs (R13 merge train, O-15; hardened by R13's review): each zod chain of a
// schema module is marked pure in the client build, so a schema nothing reads leaves the admin
// chunks. It is an allow-list that fails closed. What these hold:
//   • every zod chain is marked, a chain once at its start and a nested call on its own, and
//     nothing else is (a call on another name, a string that spells `z.`);
//   • inside a real Vite build (the AST the build hands the plugin: TypeScript stripped,
//     reprinted), every refused form makes the build throw, naming the file and the rule: a
//     parse, a global or registry write, a property step, a method or factory off the list,
//     an optional or computed step, a chain that is not in a value position (a statement,
//     void, &&, ?:, a comma sequence, a call that is not zod's), a second `z`, a zod import
//     other than one `{ z }`, parenthesised and `as` forms included;
//   • bundled and minified, an unused schema is dropped and a used one kept (and without the
//     marks the unused one ships: the control that proves the marks are what removes it);
//   • every module in packages/schemas goes through the plugin in one real build without
//     tripping it;
//   • the plugin refuses a zod other than 3, and a client build with source maps on;
//   • the plugin is the client environment's alone and astro.config.mjs installs it.

const parse = (code: string) => parseSync('fixture.ts', code, { lang: 'ts' }).program;
const annotate = (code: string) => annotateZodCalls(code, parse(code), 'fixture.ts');
const PURE = '/* @__PURE__ */ ';

describe('annotateZodCalls', () => {
  it('marks each zod chain: a chain once, a nested call on its own', () => {
    const code = [
      "import { z } from 'zod';",
      "const note = 'z.object(x) and مرحبا';",
      'export const A = z.object({ t: z.string().min(1), n: z.array(z.number()) }).strict();',
      'export const B = A.extend({ c: z.boolean() });',
      'export const C = z.coerce.number().int().default(1);',
      'export const run = () => other.call(z, z.ZodIssueCode.custom);',
    ].join('\n');
    const out = annotate(code)!;
    expect(out).toContain(
      `export const A = ${PURE}z.object({ t: ${PURE}z.string().min(1), n: ${PURE}z.array(${PURE}z.number()) }).strict();`,
    );
    // A chain rooted at another name is not zod's, whatever its arguments are.
    expect(out).toContain(`export const B = A.extend({ c: ${PURE}z.boolean() });`);
    expect(out).toContain(`export const C = ${PURE}z.coerce.number().int().default(1);`);
    // `z` passed as a value, and a chain with no call, are left alone.
    expect(out).toContain('export const run = () => other.call(z, z.ZodIssueCode.custom);');
    // The Arabic before the calls does not shift the marks (UTF-16 offsets); strings stay.
    expect(out).toContain("const note = 'z.object(x) and مرحبا';");
    expect(out.split(PURE)).toHaveLength(7);
  });

  it('follows an aliased import, and leaves a module without zod alone', () => {
    expect(annotate("import { z as v } from 'zod';\nexport const A = v.string();")).toBe(
      `import { z as v } from 'zod';\nexport const A = ${PURE}v.string();`,
    );
    expect(annotate('export const z = { a: 1 };\nz.a;')).toBeNull();
    expect(annotate("import type { z } from 'zod';\nexport type T = z.infer<X>;")).toBeNull();
  });

  it.each([
    ['a parameter', 'export const f = list.map((z) => z.value);'],
    ['a destructured const', 'const { z } = other;'],
    ['a function', 'function z() {}'],
    ['a catch binding', 'try { run(); } catch (z) { log(z); }'],
    ['a class', 'class z {}'],
  ])('refuses a module that declares a second z (%s)', (_name, line) => {
    expect(() => annotate(`import { z } from 'zod';\n${line}`)).toThrow(/declares its own `z`/);
  });
});

/** zod and its subpaths stay external: the fixtures need only the transform. */
const ZOD_EXTERNAL = /^zod(\/|$)/;

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * A real Vite build (minified, zod external) of an entry that re-exports `fixture` from
 * packages/schemas/fixture.ts, with the plugin unless `marks` is false. Returns the code.
 */
async function viteBuild(
  fixture: string,
  {
    marks = true,
    entry,
    sourcemap = false,
  }: { marks?: boolean; entry?: string; sourcemap?: boolean } = {},
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'zod-pure-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'packages', 'schemas'), { recursive: true });
  writeFileSync(join(dir, 'packages', 'schemas', 'fixture.ts'), fixture);
  writeFileSync(join(dir, 'entry.ts'), entry ?? "export * from './packages/schemas/fixture.ts';");
  const result = await build({
    root: dir,
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: true,
      sourcemap,
      rollupOptions: { input: join(dir, 'entry.ts'), external: [ZOD_EXTERNAL] },
    },
    plugins: marks ? [zodPurePlugin()] : [],
  });
  const outputs = (Array.isArray(result) ? result : [result]) as Rolldown.RolldownOutput[];
  return outputs
    .flatMap((o) => o.output)
    .map((chunk) => (chunk.type === 'chunk' ? chunk.code : ''))
    .join('\n');
}

const Z = "import { z } from 'zod';\n";
const MAP = 'const map = () => ({ message: "x" });\n';

describe('the build refuses a zod chain off the allow-list', () => {
  it.each([
    // Effects, in every position the first version missed.
    ['a statement on its own', `${Z}z.string().min(1);`, /a statement on its own/],
    [
      'setErrorMap',
      `${Z}${MAP}z.setErrorMap(map);`,
      /`z\.setErrorMap` is not a schema factory.*runs or registers/,
    ],
    [
      'void',
      `${Z}export function check(v: unknown) { void z.string(); return v; }`,
      /a unary operand/,
    ],
    [
      'void with a parse',
      `${Z}export function check(v: unknown) { void z.string().parse(v); return v; }`,
      /calls `\.parse\(\)`, which runs or registers/,
    ],
    [
      '&&',
      `${Z}export function check(v: unknown) { v != null && z.string().parse(v); return v; }`,
      /calls `\.parse\(\)`/,
    ],
    [
      '&& (a schema)',
      `${Z}export const on = (v: boolean) => { v && z.string(); };`,
      /&& \/ \|\| \/ \?\?/,
    ],
    ['?:', `${Z}export const pick = (v: boolean) => (v ? z.string() : null);`, /a branch of \?:/],
    ['a comma sequence', `${Z}export const n = (z.string(), 0);`, /a comma sequence/],
    ['an optional call', `${Z}${MAP}z.setErrorMap?.(map);`, /optional call/],
    ['an optional step', `${Z}export const S = z.string()?.min(1);`, /optional/],
    [
      "an unused local's parse",
      `${Z}export function check(v: unknown) { const checked = z.string().email().parse(v); return v; }`,
      /calls `\.parse\(\)`/,
    ],
    [
      'safeParse in a value',
      `${Z}export const ok = (v: unknown) => z.string().safeParse(v).success;`,
      /calls `\.safeParse\(\)`/,
    ],
    [
      '.options.map(effect)',
      `${Z}const seen: string[] = [];\nexport const KINDS = z.enum(['a', 'b']).options.map((k) => seen.push(k));`,
      /reads the property `\.options`/,
    ],
    [
      'z.util',
      `${Z}export const f = (x: never) => z.util.assertNever(x);`,
      /`z\.util` is not a schema factory/,
    ],
    [
      'describe',
      `${Z}export const S = z.string().describe('a name');`,
      /`\.describe\(\)`, which runs or registers/,
    ],
    [
      'a method off the list',
      `${Z}export const S = z.string().brand();`,
      /not on the allow-list of schema-building methods/,
    ],
    ['a computed step', `${Z}export const S = z['string']();`, /computed step/],
    [
      'an argument of a call that is not zod',
      `${Z}const wrap = <T>(s: T) => s;\nexport const S = wrap(z.string());`,
      /an argument of a call that is not a zod chain/,
    ],
    // Bindings and imports.
    [
      'a second z binding',
      // `S` keeps the import: the build drops an import nothing reads before the plugin runs.
      `${Z}export const S = z.string();\nexport const f = (list: { v: number }[]) => list.map((z) => z.v);`,
      /declares its own `z`/,
    ],
    [
      'a second zod import',
      `${Z}import { z as v } from 'zod/v3';\nexport const A = z.string();\nexport const S = v.string();`,
      /imports zod's `z` more than once/,
    ],
    [
      'a namespace import',
      `${Z}import * as zz from 'zod';\nexport const S = zz.string();`,
      /other than as one named `\{ z \}`/,
    ],
    // Parenthesised and `as` forms: the build strips both before the plugin sees the code.
    ['a parenthesised statement', `${Z}(z.string().min(1));`, /a statement on its own/],
    [
      'a parenthesised effect',
      `${Z}${MAP}(z.setErrorMap(map));`,
      /`z\.setErrorMap` is not a schema factory/,
    ],
    ['an `as` statement', `${Z}z.string() as unknown;`, /a statement on its own/],
    [
      'an `as` effect',
      `${Z}${MAP}z.setErrorMap(map) as void;`,
      /`z\.setErrorMap` is not a schema factory/,
    ],
  ])('%s', async (_name, fixture, rule) => {
    const thrown = await viteBuild(fixture).then(
      () => null,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toMatch(
      /scripts\/zod-pure\.mjs refuses .*packages[\\/]schemas[\\/]fixture\.ts/,
    );
    expect(message).toMatch(rule);
  });
});

describe('the bundle', () => {
  const fixture = [
    Z,
    "export const Used = z.object({ kept: z.literal('USED_MARKER') });",
    "export const Unused = z.object({ gone: z.literal('UNUSED_MARKER') }).strict();",
  ].join('\n');
  const entry =
    "import { Used } from './packages/schemas/fixture.ts';\n(globalThis as { kept?: unknown }).kept = Used;";

  it('drops an unused schema and keeps the used one', async () => {
    const code = await viteBuild(fixture, { entry });
    expect(code).toContain('USED_MARKER');
    expect(code).not.toContain('UNUSED_MARKER');
  });

  it('ships the unused schema without the marks (the control)', async () => {
    expect(await viteBuild(fixture, { entry, marks: false })).toContain('UNUSED_MARKER');
  });

  it('refuses a client build with source maps on (the marks would shift its columns)', async () => {
    await expect(viteBuild(fixture, { entry, sourcemap: true })).rejects.toThrow(
      /source maps are on/,
    );
  });
});

describe('the schema modules', () => {
  const root = process.cwd();
  const dir = join(root, 'packages', 'schemas');
  const modules = readdirSync(dir)
    .map((f) => join(dir, f))
    .filter((f) => SCHEMA_MODULE.test(f));

  it('are found', () => {
    expect(modules.length).toBeGreaterThan(20);
  });

  it('all pass through the plugin in one real build', async () => {
    const plugin = zodPurePlugin();
    const hook = plugin.transform as {
      handler: (this: unknown, code: string, id: string) => { code: string } | null;
    };
    const handler = hook.handler;
    const seen = new Map<string, number>();
    hook.handler = function (code, id) {
      const result = handler.call(this, code, id);
      seen.set(id.split('?')[0]!, result ? result.code.split(PURE).length - 1 : 0);
      return result;
    };
    await build({
      root,
      configFile: false,
      logLevel: 'silent',
      build: {
        write: false,
        minify: true,
        rollupOptions: { input: modules, external: [ZOD_EXTERNAL] },
      },
      plugins: [plugin as Plugin],
    });
    const slash = (p: string) => p.replace(/\\/g, '/');
    expect([...seen.keys()].map(slash).sort()).toEqual(modules.map(slash).sort());
    // The marks are placed (a module like release.ts carries hundreds).
    expect([...seen.values()].reduce((a, b) => a + b, 0)).toBeGreaterThan(1000);
  });
});

describe('the plugin', () => {
  it('runs in the client environment only, at build time', () => {
    const plugin = zodPurePlugin();
    const applies = plugin.applyToEnvironment as (env: { name: string }) => boolean;
    expect(applies({ name: 'client' })).toBe(true);
    expect(applies({ name: 'ssr' })).toBe(false);
    expect(applies({ name: 'prerender' })).toBe(false);
    expect(plugin.apply).toBe('build');
  });

  it('loads only on zod 3, and the installed zod is 3', () => {
    expect(installedZodVersion()).toMatch(/^3\./);
    expect(() => assertZodMajor('3.25.76')).not.toThrow();
    expect(() => assertZodMajor('4.0.0')).toThrow(/not 3.*globalRegistry/);
  });

  it('is installed by astro.config.mjs', () => {
    const config = readFileSync(join(process.cwd(), 'astro.config.mjs'), 'utf8');
    expect(config).toMatch(/plugins: \[zodPurePlugin\(\)\]/);
  });
});
