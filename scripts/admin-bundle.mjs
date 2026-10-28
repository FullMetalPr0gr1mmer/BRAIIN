// Admin bundle gate (Admin v2 F4, docs/admin-v2/README.md P-10). Runs after `npm run
// build` as part of `npm run size`, next to size-limit's two sums.
//
// size-limit weighs files by NAME: every admin-* file summed, lazy ones included. What a
// person waits for is narrower: the files a browser must fetch before an admin screen
// runs, i.e. the island's STATIC import graph. This script measures that graph per admin
// entry and checks the chunk plan in astro.config.mjs actually holds:
//   1. the rich-text editor (admin-rich) is reached only through import(), never
//      statically, so a screen without a rich-text field never downloads it;
//   2. no public chunk imports an admin chunk, statically or lazily (the public budget
//      excludes admin-* by name, so such an import would hide admin weight from it);
//   3. each admin screen's eager graph stays within ROUTE_BUDGET, and the sign-in
//      screens' scripts within LOGIN_BUDGET (since F7 they have none: 0 B, reported so);
//   4. the chunks hold what their names say (admin-ui carries no ProseMirror), and the
//      shared admin-ui chunk statically imports none of the groups meant to stay off the
//      screens that do not need them (admin-fields, admin-screens, admin-dashboard): a
//      group takes its modules' static dependencies, so such an import would put the field
//      kit, or another screen's code, on every admin screen (Admin v2 U4, Wave 3's rule);
//   5. no admin code hides under another name: a chunk that only admin chunks load, by a
//      static or a lazy import, is named admin-* or Admin* (a module no group claims
//      becomes a module-named chunk, which size-limit weighs as public JavaScript). The
//      bundler's own runtime helpers, shared by every graph, are the exception by name;
//   6. a screen family's own group stays on its own screens (Admin v2 C4b, the leads): only
//      its islands and its lazy pieces import admin-leads statically, admin-leads imports
//      neither the field kit nor its lazy pieces statically, and nothing imports the lazy
//      pieces (admin-leads-lazy: Add a lead, Erase) but through import().
//   7. the preview bridge (Admin v2 R9) loads neither React nor admin-ui: a `/admin/preview/**`
//      render runs a public page, and its bridge needs zod and the envelope only (admin-zod).
//   8. the savebar (Admin v2 R12, admin-release) is the savebar island's and the kit gallery's
//      alone, and never loads the field kit: AdminLayout draws it on every screen while
//      releases are on, so each screen's eager graph below counts it as part of the shell.
//      Admin v2 R13: the dashboard's publish card shares it (drawn only while releases are on),
//      and Backups & versions' own group (admin-versions) imports its schedule rules from it;
//      admin-versions is its island's and the kit gallery's alone, and the history drawer
//      (admin-history) is reached only through import() from the editors.
//
// Since C4b (owner item O-15, decided by the approved plan's default on 2026-10-18) check 3,
// each admin screen's eager graph within ROUTE_BUDGET, is THE admin bundle gate; the
// size-limit sum in .size-limit.json (every admin-* file, lazy ones included) is a coarse
// 400 KB tripwire beside it, no longer the budget.
// Sizes are gzip bytes; KB means 1,000 B.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROUTE_BUDGET = 300_000;
export const LOGIN_BUDGET = 10_000;
export const RICH_BUDGET = 140_000;

/** Static imports of a chunk: `import … from "./x.js"`, `import "./x.js"`, `export … from`. */
export function staticImports(source) {
  const out = new Set();
  for (const m of source.matchAll(
    /(?:^|[;\s}])(?:import|export)\s*(?:[\w*{}\s,$]+?\s*from\s*)?["']\.\/([\w.$-]+\.js)["']/g,
  )) {
    out.add(m[1]);
  }
  return [...out];
}

/** Lazy imports: `import("./x.js")` or a template-literal specifier. */
export function dynamicImports(source) {
  return [
    ...new Set(
      [...source.matchAll(/import\(\s*["'`]\.\/([\w.$-]+\.js)["'`]\s*\)/g)].map((m) => m[1]),
    ),
  ];
}

export function closure(entry, read) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const dep of staticImports(read(file))) stack.push(dep);
  }
  return seen;
}

// The sign-in screens (Admin v2 F7): login, forgot and reset, the invite page (U12b), and
// their shell AuthLayout.
// Zero-JS since F7 (tests/lib/adminConventions.spec.ts), so no such chunk is built; one
// that appears is weighed against LOGIN_BUDGET.
const SIGN_IN_FILE = /^(?:login|forgot|reset|invite|AuthLayout)\.astro_/;

// The bundler's runtime helpers: shared by public and admin graphs alike (preload-helper is
// its own neutral group in astro.config.mjs; rolldown-runtime is Rolldown's), so neither is
// admin code whoever happens to load it in a given build.
const RUNTIME_FILE = /^(?:preload-helper|rolldown-runtime)\./;

// The groups admin-ui must never import statically (check 4).
const OFF_SCREEN_GROUPS = [
  'admin-fields.',
  'admin-screens.',
  'admin-content.',
  'admin-pages.',
  'admin-dashboard.',
  'admin-leads.',
  'admin-leads-lazy.',
  'admin-preview.',
  'admin-release.',
  'admin-versions.',
  'admin-history.',
];

// A screen family's group and the chunks allowed to import it statically (check 6).
const FAMILY_GROUPS = [
  { group: 'admin-leads.', importers: /^(?:AdminLead|admin-leads-lazy\.)/ },
  // Admin v2 R12: the savebar's island, and the kit's gallery that draws it.
  // Admin v2 R13: the dashboard's publish card, and Backups & versions' list, which reuses the
  // publish dialog's schedule rules (both drawn only while releases are on).
  {
    group: 'admin-release.',
    importers: /^(?:AdminSavebar|AdminPublishCard|AdminKit|admin-versions)\./,
  },
  // Admin v2 R13: Backups & versions' list, on its own island and the kit's gallery.
  { group: 'admin-versions.', importers: /^(?:AdminVersions|AdminKit)\./ },
  // Admin v2 U5 + U6: the Services and Projects areas' own group, on their five islands only.
  {
    group: 'admin-content.',
    importers: /^Admin(?:Services|Discipline|ServiceEditor|Projects|ProjectEditor)\./,
  },
  // Admin v2 E1: the page editor's own group, on its island only.
  { group: 'admin-pages.', importers: /^AdminPageEditor\./ },
];
// What a family's group must never import statically: the field kit, and its own lazy part.
const FAMILY_NEVER = {
  'admin-leads.': ['admin-fields.', 'admin-leads-lazy.'],
  'admin-release.': ['admin-fields.'],
  'admin-versions.': ['admin-fields.'],
  // E1: the page editor loads the field kit, never another screen family's code.
  'admin-pages.': ['admin-screens.', 'admin-content.', 'admin-leads.', 'admin-versions.'],
};
// Groups reached only through import() (check 6). Admin v2 R13: the history drawer.
const LAZY_ONLY_GROUPS = ['admin-leads-lazy.', 'admin-history.'];

// The preview bridge's script (check 7) and what its eager graph must never hold.
const PREVIEW_BRIDGE_FILE = /^AdminPreviewBridge\.astro_/;
const PREVIEW_NEVER = ['admin-vendor.', 'admin-ui.'];

// Every admin chunk is `admin-*` (the groups in astro.config.mjs) or an island entry named
// `Admin*` (src/components/admin/islands), plus a sign-in screen's script. A chunk named
// otherwise is public, whatever it holds.
const ADMIN_FILE = /^(?:admin-|Admin|(?:login|forgot|reset|invite|AuthLayout)\.astro_)/;

export function check(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
  const cache = new Map();
  const read = (f) => {
    if (!cache.has(f)) cache.set(f, readFileSync(join(dir, f), 'utf8'));
    return cache.get(f);
  };
  const gz = (f) => gzipSync(read(f)).length;
  const sum = (set) => [...set].reduce((n, f) => n + gz(f), 0);
  const find = (prefix) => files.find((f) => f.startsWith(prefix));
  const problems = [];
  const report = [];

  const rich = find('admin-rich.');
  const ui = find('admin-ui.');
  if (!rich) problems.push('no admin-rich chunk: the editor is not split out');
  if (!ui) problems.push('no admin-ui chunk');

  // 4. Contents.
  if (ui && /ProseMirror|prosemirror-view/.test(read(ui))) {
    problems.push('admin-ui holds ProseMirror code: the editor is no longer isolated');
  }
  if (rich && gz(rich) > RICH_BUDGET) {
    problems.push(`admin-rich is ${gz(rich)} B gz, over its ${RICH_BUDGET} B cap`);
  }
  if (ui) {
    const pulled = staticImports(read(ui)).filter((d) =>
      OFF_SCREEN_GROUPS.some((group) => d.startsWith(group)),
    );
    if (pulled.length) {
      problems.push(
        `admin-ui imports ${pulled.join(', ')} statically: it would load on every screen`,
      );
    }
  }

  // 6. A screen family's group stays on its own screens; its lazy pieces stay lazy.
  for (const { group, importers } of FAMILY_GROUPS) {
    const chunk = find(group);
    if (!chunk) continue;
    for (const f of files) {
      if (f === chunk || importers.test(f)) continue;
      if (staticImports(read(f)).includes(chunk)) {
        problems.push(`${f} imports ${chunk} statically: another screen would load it`);
      }
    }
    const never = (FAMILY_NEVER[group] ?? []).filter((prefix) =>
      staticImports(read(chunk)).some((d) => d.startsWith(prefix)),
    );
    if (never.length) {
      problems.push(`${chunk} imports ${never.join(', ')} statically: it would load eagerly`);
    }
  }
  for (const prefix of LAZY_ONLY_GROUPS) {
    const chunk = find(prefix);
    if (!chunk) continue;
    const eager = files.filter((f) => staticImports(read(f)).includes(chunk));
    if (eager.length) {
      problems.push(
        `${eager.join(', ')} import ${chunk} statically: it is meant for import() only`,
      );
    }
  }

  // 7. The preview bridge loads neither React nor admin-ui.
  for (const bridge of files.filter((f) => PREVIEW_BRIDGE_FILE.test(f))) {
    const pulled = [...closure(bridge, read)].filter((f) =>
      PREVIEW_NEVER.some((prefix) => f.startsWith(prefix)),
    );
    if (pulled.length) {
      problems.push(
        `${bridge} loads ${pulled.sort().join(', ')} eagerly: a preview render needs neither`,
      );
    }
  }

  // 5. A chunk only admin code loads is admin code, whatever Rolldown named it.
  const loaders = new Map();
  for (const f of files) {
    for (const d of [...staticImports(read(f)), ...dynamicImports(read(f))]) {
      loaders.set(d, [...(loaders.get(d) ?? []), f]);
    }
  }
  for (const f of files) {
    if (ADMIN_FILE.test(f) || RUNTIME_FILE.test(f) || /^client\./.test(f)) continue;
    const by = loaders.get(f) ?? [];
    if (by.length > 0 && by.every((loader) => ADMIN_FILE.test(loader))) {
      problems.push(
        `${f} is loaded only by admin chunks (${by.join(', ')}) but is not named admin-*: size-limit weighs it as public JavaScript`,
      );
    }
  }

  // 2. Public chunks never import admin ones.
  for (const f of files.filter((name) => !ADMIN_FILE.test(name) && !/^client\./.test(name))) {
    const deps = [...staticImports(read(f)), ...dynamicImports(read(f))];
    const leaked = deps.filter((d) => ADMIN_FILE.test(d));
    if (leaked.length) problems.push(`public chunk ${f} imports ${leaked.join(', ')}`);
  }

  // 1 + 3. Each admin entry's eager graph.
  const renderer = files.find((f) => /^client\.[\w-]+\.js$/.test(f));
  const layout = find('AdminLayout.astro_');
  const chrome = find('AdminChrome.');
  // Admin v2 R12: the savebar is on every admin screen while releases are on, so it is counted
  // as part of the shell (with releases off no screen loads it: the count is the worst case).
  const savebar = find('AdminSavebar.');
  const shell = new Set([
    ...(layout ? closure(layout, read) : []),
    ...(chrome ? closure(chrome, read) : []),
    ...(savebar ? closure(savebar, read) : []),
    ...(renderer ? closure(renderer, read) : []),
  ]);
  const islands = files.filter(
    (f) =>
      ADMIN_FILE.test(f) &&
      !/^admin-/.test(f) &&
      !SIGN_IN_FILE.test(f) &&
      !f.startsWith('AdminLayout'),
  );
  for (const island of islands) {
    const graph = new Set([...shell, ...closure(island, read)]);
    if (rich && graph.has(rich)) problems.push(`${island} loads admin-rich eagerly`);
    const bytes = sum(graph);
    report.push([island.replace(/\.[\w-]+\.js$/, ''), bytes]);
    if (bytes > ROUTE_BUDGET) problems.push(`${island}: ${bytes} B gz eager, over ${ROUTE_BUDGET}`);
  }
  // Every sign-in screen's script with what it imports, each file counted once: 0 B when,
  // as since F7, there is none. Reported either way, so the size line says what they load.
  const signIn = new Set(
    files.filter((f) => SIGN_IN_FILE.test(f)).flatMap((f) => [...closure(f, read)]),
  );
  const signInBytes = sum(signIn);
  report.push(['sign-in screens script (login, forgot, reset, invite)', signInBytes]);
  if (signInBytes > LOGIN_BUDGET)
    problems.push(`the sign-in script loads ${signInBytes} B gz, over ${LOGIN_BUDGET}`);
  if (rich) report.push(['admin-rich (lazy)', gz(rich)]);
  return { problems, report };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = process.argv[2] ?? 'dist/client/_astro';
  if (!existsSync(dir)) {
    console.error(`admin-bundle: ${dir} not found — run the build first`);
    process.exit(1);
  }
  const { problems, report } = check(dir);
  console.log('Admin eager JS per entry (gzip, layout + palette + renderer included):');
  for (const [name, bytes] of report)
    console.log(`  ${(bytes / 1000).toFixed(1).padStart(7)} kB  ${name}`);
  if (problems.length) {
    for (const p of problems) console.error(`  ✘ ${p}`);
    process.exit(1);
  }
  console.log('  ✓ admin chunk plan holds');
}
