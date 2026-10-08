import type { Case } from '../harness';

// The endpoint cases of the authorization matrix (tests/authz/endpoints.spec.ts), one
// module per admin feature, each exporting `cases`. They are collected by path, subfolders
// included (`crm/notes.ts` is the feature `crm/notes`), so a feature adds its own module and
// edits nothing here.
//
// What keeps a module from going missing unnoticed (a merge that drops a file or a row):
// tests/authz/caseManifest.ts pins every case name, module by module, and
// tests/authz/endpointCoverage.spec.ts holds this collection to it and to the files on disk,
// and requires every method exported under src/pages/api/admin to have a case.

const MODULES = import.meta.glob<readonly Case[] | undefined>(['./**/*.ts', '!./index.ts'], {
  eager: true,
  import: 'cases',
});

/** Feature (the module's path under cases/, without `.ts`) → its cases. */
export const CASE_MODULES: Readonly<Record<string, readonly Case[]>> = Object.fromEntries(
  Object.entries(MODULES).map(([path, cases]) => {
    const feature = path.replace(/^\.\/(.+)\.ts$/, '$1');
    if (!Array.isArray(cases)) {
      throw new Error(`tests/authz/cases/${feature}.ts must export its rows as \`cases\``);
    }
    return [feature, cases];
  }),
);

/** Every case of every feature. */
export const CASES: readonly Case[] = Object.values(CASE_MODULES).flat();
