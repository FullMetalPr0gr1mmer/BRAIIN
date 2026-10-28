import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSync } from 'vite';
import { rolldown, type Plugin as RolldownPlugin } from 'rolldown';
import { annotateZodCalls, SCHEMA_MODULE, zodPurePlugin } from '../../scripts/zod-pure.mjs';

// scripts/zod-pure.mjs (R13 merge train, O-15): each call rooted at a schema module's zod
// import is marked pure in the client build, so a schema nothing reads leaves the admin
// chunks. What these hold:
//   • every zod call is marked, a chain once at its start and a nested call on its own, and
//     nothing else is (a call on another name, a string that spells `z.`);
//   • a module that declares a second `z`, or calls zod for its effect alone, is refused, so
//     a mark can never land on a call that is not zod's or delete one that matters;
//   • bundled, an unused schema is dropped and a used one kept (and without the marks the
//     unused one ships: the control that proves the marks are what removes it);
//   • every module in packages/schemas passes, so the build cannot trip on one today;
//   • the plugin is the client environment's alone and astro.config.mjs installs it.

const parse = (code: string) => parseSync('fixture.ts', code, { lang: 'ts' }).program;
const annotate = (code: string) => annotateZodCalls(code, parse(code), 'fixture.ts');
const PURE = '/* @__PURE__ */ ';

describe('annotateZodCalls', () => {
  it('marks each zod call: a chain once, a nested call on its own', () => {
    const code = [
      "import { z } from 'zod';",
      "const note = 'z.object(x) and مرحبا';",
      'export const A = z.object({ t: z.string().min(1), n: z.array(z.number()) }).strict();',
      'export const B = A.extend({ c: z.boolean() });',
      'export const run = () => other.call(z);',
    ].join('\n');
    const out = annotate(code)!;
    expect(out).toContain(
      `export const A = ${PURE}z.object({ t: ${PURE}z.string().min(1), n: ${PURE}z.array(${PURE}z.number()) }).strict();`,
    );
    // A chain rooted at another name is not zod's, whatever its arguments are.
    expect(out).toContain(`export const B = A.extend({ c: ${PURE}z.boolean() });`);
    expect(out).toContain('export const run = () => other.call(z);');
    // The Arabic before the calls does not shift the marks (UTF-16 offsets); strings stay.
    expect(out).toContain("const note = 'z.object(x) and مرحبا';");
    expect(out.split(PURE)).toHaveLength(6);
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

  it('refuses a zod call made for its effect alone', () => {
    expect(() => annotate("import { z } from 'zod';\nz.setErrorMap(map);")).toThrow(
      /for its effect alone/,
    );
  });
});

/** Bundles a two-schema module behind an entry that reads one of them. */
async function bundle(marks: boolean): Promise<string> {
  const files: Record<string, string> = {
    '/v/entry.ts': "import { Used } from '/v/packages/schemas/fixture.ts';\nexport { Used };",
    '/v/packages/schemas/fixture.ts': [
      "import { z } from 'zod';",
      "export const Used = z.object({ kept: z.literal('USED_MARKER') });",
      "export const Unused = z.object({ gone: z.literal('UNUSED_MARKER') }).strict();",
    ].join('\n'),
  };
  const virtual: RolldownPlugin = {
    name: 'virtual',
    resolveId: (id) => (id in files ? id : null),
    load: (id) => files[id] ?? null,
  };
  const pure = zodPurePlugin();
  const build = await rolldown({
    input: '/v/entry.ts',
    external: ['zod'],
    plugins: marks ? [virtual, pure as unknown as RolldownPlugin] : [virtual],
  });
  const { output } = await build.generate({ format: 'esm' });
  return output[0].code;
}

describe('the bundle', () => {
  it('drops an unused schema and keeps the used one', async () => {
    const code = await bundle(true);
    expect(code).toContain('USED_MARKER');
    expect(code).not.toContain('UNUSED_MARKER');
  });

  it('ships the unused schema without the marks (the control)', async () => {
    expect(await bundle(false)).toContain('UNUSED_MARKER');
  });
});

describe('the schema modules', () => {
  const dir = join(process.cwd(), 'packages', 'schemas');
  const modules = readdirSync(dir).filter((f) => SCHEMA_MODULE.test(join(dir, f)));

  it('are found', () => {
    expect(modules.length).toBeGreaterThan(20);
  });

  it.each(modules)('%s declares no second z and calls zod for no effect', (file) => {
    const code = readFileSync(join(dir, file), 'utf8');
    expect(() => annotateZodCalls(code, parse(code), file)).not.toThrow();
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

  it('is installed by astro.config.mjs', () => {
    const config = readFileSync(join(process.cwd(), 'astro.config.mjs'), 'utf8');
    expect(config).toMatch(/plugins: \[zodPurePlugin\(\)\]/);
  });
});
