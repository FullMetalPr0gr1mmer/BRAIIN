import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { check } from '../../scripts/admin-bundle.mjs';

// Import contacts has its own chunk group (Admin v2 C15, astro.config.mjs `admin-import`): its
// island, its screen code and the file reading it shares with the route, so no other admin
// screen loads them and the shared admin-ui chunk (every screen's) never does. Kept in a file
// of its own beside tests/lib/adminBundle.spec.ts, which pins the other families the same way.

function build(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'admin-bundle-import-'));
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
  'preload-helper.H1.js': 'export const h=1;',
  'admin-fields.F1.js': 'import"./admin-ui.U1.js";export const f=1;',
  'admin-contacts.K1.js': 'import"./admin-ui.U1.js";',
  'AdminContactsList.K2.js': 'import"./admin-contacts.K1.js";',
  'admin-import.I1.js': 'import"./admin-ui.U1.js";',
  'AdminImportContacts.I2.js': 'import"./admin-import.I1.js";',
};

describe('Import contacts has its own group (Admin v2 C15)', () => {
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
  const priority = (name: string) => groups.find((g) => g.name === name)!.priority;

  it('claims its island, its screen, the file reading and the request schemas', () => {
    const screen = 'src/components/admin/screens/contacts-import';
    const paths = [
      'src/components/admin/islands/AdminImportContacts.tsx',
      ...readdirSync(join(process.cwd(), screen)).map((name) => `${screen}/${name}`),
      'src/lib/crm/importCsv.ts',
      'src/lib/crm/importScreen.ts',
      'packages/schemas/crmImport.ts',
    ];
    for (const path of paths) expect(claim(path), path).toBe('admin-import');
    // The contacts screens' group keeps its own: the island's name does not start "AdminContact".
    expect(claim('src/components/admin/islands/AdminContactsList.tsx')).toBe('admin-contacts');
    // The server's halves are never in a browser chunk group of this family.
    expect(claim('src/lib/crm/importRows.ts')).not.toBe('admin-import');
  });

  it('sits below the field kit and above the shared screens group', () => {
    expect(priority('admin-import')).toBeLessThan(priority('admin-fields'));
    expect(priority('admin-import')).toBeGreaterThan(priority('admin-screens'));
  });

  it('is loaded statically by its island only, and loads no other screen family', () => {
    expect(check(build(GOOD)).problems).toEqual([]);
    const problems = (files: Record<string, string>) =>
      (check(build({ ...GOOD, ...files })).problems as string[]).join('\n');
    expect(problems({ 'AdminContactsList.K2.js': 'import"./admin-import.I1.js";' })).toContain(
      'AdminContactsList.K2.js imports admin-import.I1.js statically',
    );
    expect(
      problems({
        'admin-import.I1.js': 'import"./admin-ui.U1.js";import"./admin-contacts.K1.js";',
      }),
    ).toContain('admin-import.I1.js imports admin-contacts. statically');
    expect(
      problems({ 'admin-import.I1.js': 'import"./admin-ui.U1.js";import"./admin-fields.F1.js";' }),
    ).toContain('admin-import.I1.js imports admin-fields. statically');
    expect(
      problems({
        'admin-ui.U1.js': 'import"./admin-import.I1.js";const L=()=>import(`./admin-rich.X1.js`);',
      }),
    ).toContain('admin-ui imports admin-import.I1.js statically');
  });
});
