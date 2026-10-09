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
//      page's script within LOGIN_BUDGET;
//   4. the chunks hold what their names say (admin-ui carries no ProseMirror).
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

// Every admin chunk is `admin-*` (the groups in astro.config.mjs) or an island entry named
// `Admin*` (src/components/admin/islands), plus the sign-in page's script. A chunk named
// otherwise is public, whatever it holds.
const ADMIN_FILE = /^(admin-|Admin|login\.astro_)/;

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
  const shell = new Set([
    ...(layout ? closure(layout, read) : []),
    ...(chrome ? closure(chrome, read) : []),
    ...(renderer ? closure(renderer, read) : []),
  ]);
  const islands = files.filter(
    (f) =>
      ADMIN_FILE.test(f) &&
      !/^admin-/.test(f) &&
      !f.startsWith('login.astro_') &&
      !f.startsWith('AdminLayout'),
  );
  for (const island of islands) {
    const graph = new Set([...shell, ...closure(island, read)]);
    if (rich && graph.has(rich)) problems.push(`${island} loads admin-rich eagerly`);
    const bytes = sum(graph);
    report.push([island.replace(/\.[\w-]+\.js$/, ''), bytes]);
    if (bytes > ROUTE_BUDGET) problems.push(`${island}: ${bytes} B gz eager, over ${ROUTE_BUDGET}`);
  }
  const login = find('login.astro_');
  if (login) {
    const bytes = sum(closure(login, read));
    report.push(['/admin/login script', bytes]);
    if (bytes > LOGIN_BUDGET)
      problems.push(`the sign-in script loads ${bytes} B gz, over ${LOGIN_BUDGET}`);
  }
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
