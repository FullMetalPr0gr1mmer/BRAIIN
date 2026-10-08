// Renumber a branch's NEW migration above the base branch's highest: the fix that
// scripts/check-migrations.mjs (rule 4) asks for when another branch merged the same
// number first.
//
// Migrations apply in number order, and a file on the base branch is immutable (production
// may have applied it), so the branch that lands second moves its own file up. By hand that
// is a rename plus every place the old name is written down. This does both:
//
//   1. refuses a file that exists on the base;
//   2. renames the file with `git mv` to the next number above the base's highest. Several
//      new migrations on one branch keep their order: each takes the base's highest plus
//      its place among them, and a move that would jump another one is refused, naming the
//      one to move first;
//   3. rewrites references in supabase/tests/*.sql, docs/**/*.md, CLAUDE.md and the header
//      comments of the branch's new migrations (its own, and a sibling's "Depends on").
//      The file name (with or without `.sql`) names this migration alone, so it is
//      rewritten wherever it appears. A bare number ("0038") is rewritten only on lines
//      this branch added, because anywhere else it can be the base's own 0038;
//   4. lists every file it changed, then every line it left alone that still names the old
//      migration (the SQL under a header, a comment in src/) for a reader to check.
//
//   node scripts/renumber-migration.mjs supabase/migrations/0038_leads_write.sql
//   node scripts/renumber-migration.mjs 0038_leads_write.sql --base origin/main --dry-run
//
// Merge the base in first (git fetch origin && git merge origin/main), so "lines this
// branch added" means exactly that; then run scripts/check-migrations.mjs.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DIR = 'supabase/migrations';
/** The ledger's file name rule, as scripts/check-migrations.mjs states it. */
export const NAME = /^(\d{4})_[a-z0-9_]+\.sql$/;

const USAGE = 'usage: node scripts/renumber-migration.mjs <file> [--base origin/main] [--dry-run]';

const pad = (/** @type {number} */ n) => String(n).padStart(4, '0');
const numberOf = (/** @type {string} */ name) => Number(NAME.exec(name)?.[1] ?? 0);

/**
 * @param {string[]} argv the arguments after the script's path
 * @returns {{ file: string, base: string, dryRun: boolean }}
 */
export function parseArgs(argv) {
  const args = { file: '', base: 'origin/main', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--base') args.base = argv[++i] ?? '';
    else if (arg.startsWith('--base=')) args.base = arg.slice('--base='.length);
    else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}\n${USAGE}`);
    else if (args.file) throw new Error(`one migration at a time\n${USAGE}`);
    else args.file = arg;
  }
  if (!args.file || !args.base) throw new Error(USAGE);
  return args;
}

/**
 * Where a migration moves to. `baseFiles` are the base branch's migrations, `headFiles`
 * the working tree's. Throws, with the reason, when the move is refused.
 *
 * @param {{ name: string, baseFiles: string[], headFiles: string[], base?: string }} input
 * @returns {{ from: string, to: string, oldName: string, newName: string, baseMax: string, noop: boolean }}
 */
export function planRenumber({ name, baseFiles, headFiles, base = 'the base' }) {
  if (!NAME.test(name)) throw new Error(`${name}: not a migration name (NNNN_snake_case.sql)`);
  if (baseFiles.includes(name)) {
    throw new Error(
      `${name} exists on ${base}, and migrations there are immutable (production may have ` +
        'applied it): write a new forward migration instead',
    );
  }
  if (!headFiles.includes(name)) throw new Error(`${name}: no such file in ${DIR}`);

  const baseMax = Math.max(0, ...baseFiles.filter((f) => NAME.test(f)).map(numberOf));
  // The branch's new migrations in the order they apply. Each takes the base's highest plus
  // its place in this list, so a set renumbered one file at a time keeps its order.
  const branchNew = headFiles.filter((f) => NAME.test(f) && !baseFiles.includes(f)).sort();
  const place = branchNew.indexOf(name);
  const to = baseMax + 1 + place;
  if (to > 9999) throw new Error(`${name}: no four-digit number is left above ${pad(baseMax)}`);

  const plan = {
    from: pad(numberOf(name)),
    to: pad(to),
    oldName: name,
    newName: `${pad(to)}${name.slice(4)}`,
    baseMax: pad(baseMax),
    noop: to === numberOf(name),
  };
  if (plan.noop) return plan;

  // The move must not carry this file past another of the branch's new migrations: the
  // later ones have to number above its new number, the earlier ones below it.
  for (const [i, other] of branchNew.entries()) {
    if (i === place) continue;
    if (i > place ? numberOf(other) <= to : numberOf(other) >= to) {
      throw new Error(
        `${other} is new on this branch too and must stay ${i > place ? 'after' : 'before'} ` +
          `${name}: renumber ${other} first`,
      );
    }
  }
  if (headFiles.includes(plan.newName)) throw new Error(`${plan.newName} already exists`);
  return plan;
}

/**
 * The line numbers (1-based, in the working tree) that `git diff -U0` reports as added.
 *
 * @param {string} diff
 * @returns {Set<number>}
 */
export function addedLines(diff) {
  const lines = new Set();
  for (const hunk of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    for (let line = start; line < start + count; line++) lines.add(line);
  }
  return lines;
}

/**
 * How many lines open a migration before its first statement: its header comment.
 *
 * @param {string} sql
 */
export function headerLength(sql) {
  const lines = sql.split('\n');
  let n = 0;
  while (n < lines.length && /^\s*(--.*)?$/.test((lines[n] ?? '').replace(/\r$/, ''))) n++;
  return n;
}

/**
 * One file's references to the old migration. The stem (its file name without `.sql`)
 * is rewritten everywhere; the bare number only on `lines` (1-based), or on every line
 * when `lines` is null.
 *
 * @param {string} text
 * @param {{ from: string, to: string, oldStem: string, newStem: string, lines?: Set<number> | null }} refs
 * @returns {{ text: string, count: number }}
 */
export function rewriteReferences(text, { from, to, oldStem, newStem, lines = null }) {
  // Not inside a longer name (0038_leads_write must not match 0038_leads_writer), and the
  // number not inside another token (10038, 0038abcd, 1.0038).
  const stem = new RegExp(`(?<!\\w)${oldStem}(?![a-z0-9_])`, 'g');
  const bare = new RegExp(`(?<![\\w.])${from}(?!\\w|\\.\\d)`, 'g');
  let count = 0;
  const out = text.split('\n').map((line, i) => {
    let next = line.replace(stem, () => {
      count++;
      return newStem;
    });
    if (lines === null || lines.has(i + 1)) {
      next = next.replace(bare, () => {
        count++;
        return to;
      });
    }
    return next;
  });
  return { text: out.join('\n'), count };
}

/**
 * The files whose references are rewritten: the pgTAP tests, the docs and CLAUDE.md.
 *
 * @param {string} root
 */
export function referenceFiles(root = '.') {
  const files = [];
  if (existsSync(`${root}/supabase/tests`)) {
    for (const f of readdirSync(`${root}/supabase/tests`)) {
      if (f.endsWith('.sql')) files.push(`supabase/tests/${f}`);
    }
  }
  if (existsSync(`${root}/docs`)) {
    for (const f of readdirSync(`${root}/docs`, { recursive: true }).map(String)) {
      if (f.endsWith('.md')) files.push(`docs/${f.replaceAll('\\', '/')}`);
    }
  }
  if (existsSync(`${root}/CLAUDE.md`)) files.push('CLAUDE.md');
  return files.sort();
}

/** @param {string[]} args */
const git = (args) =>
  execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

/** @param {string[]} args */
const gitSucceeds = (args) => {
  try {
    git(args);
    return true;
  } catch {
    return false;
  }
};

/** A command's output lines; none when it fails (git grep exits 1 on no match). */
const gitList = (/** @type {string[]} */ args) => {
  try {
    return git(args).split('\n').filter(Boolean);
  } catch {
    return [];
  }
};

/**
 * The lines of `file` this branch added, against the base; null (every line) when the base
 * does not have the file at all.
 *
 * @param {string} base
 * @param {string} file
 */
const branchLines = (base, file) =>
  gitSucceeds(['cat-file', '-e', `${base}:${file}`])
    ? addedLines(git(['diff', '-U0', '--no-color', '--no-ext-diff', base, '--', file]))
    : null;

/** @param {string[]} argv */
function main(argv) {
  const args = parseArgs(argv);
  // Paths below are from the repository's root, wherever in it this was started.
  const root = git(['rev-parse', '--show-toplevel']).trim();
  const prefix = git(['rev-parse', '--show-prefix']).trim();
  const path = posix.normalize(
    isAbsolute(args.file)
      ? relative(root, args.file).replaceAll('\\', '/')
      : `${prefix}${args.file.replaceAll('\\', '/')}`,
  );
  process.chdir(root);
  const name = posix.basename(path);
  if (path.includes('/') && posix.dirname(path) !== DIR) {
    throw new Error(`${args.file}: not a file in ${DIR}`);
  }

  let baseFiles;
  try {
    baseFiles = git(['ls-tree', '--name-only', `${args.base}:${DIR}`])
      .split('\n')
      .filter(Boolean);
  } catch {
    throw new Error(`cannot read ${DIR} at ${args.base}: fetch it first (git fetch origin)`);
  }
  const headFiles = readdirSync(DIR).filter((f) => f.endsWith('.sql'));
  const plan = planRenumber({ name, baseFiles, headFiles, base: args.base });
  if (plan.noop) {
    console.log(
      `  ✓ ${name} already numbers ${plan.to}, next above the highest on ${args.base} ` +
        `(${plan.baseMax}): nothing to do`,
    );
    return;
  }

  const would = args.dryRun ? 'would ' : '';
  const oldPath = `${DIR}/${plan.oldName}`;
  const newPath = `${DIR}/${plan.newName}`;
  const refs = {
    from: plan.from,
    to: plan.to,
    oldStem: plan.oldName.replace(/\.sql$/, ''),
    newStem: plan.newName.replace(/\.sql$/, ''),
  };
  console.log(
    `  ✓ ${args.dryRun ? 'dry run: ' : ''}${plan.oldName} → ${plan.newName} ` +
      `(the highest on ${args.base} is ${plan.baseMax})`,
  );

  const tracked = gitSucceeds(['ls-files', '--error-unmatch', '--', oldPath]);
  if (!args.dryRun) {
    if (tracked) git(['mv', '--', oldPath, newPath]);
    else renameSync(oldPath, newPath);
  }
  console.log(
    `    ${would}rename ${oldPath} → ${newPath} (${tracked ? 'git mv' : 'untracked: renamed on disk'})`,
  );

  /** @type {Set<string>} the files rewritten (or that a dry run would rewrite) */
  const touched = new Set();
  /** @type {string[]} "file:line" left alone that still names the old migration */
  const mentions = [];

  // The headers of the branch's new migrations are the branch's own words: the moved
  // file's number follows there, and so does a sibling's "Depends on 0038". The SQL below
  // a header is left alone (a number in a statement is a value, not a reference), and a
  // mention there is reported instead.
  for (const file of headFiles.filter((f) => !baseFiles.includes(f)).sort()) {
    const target = file === plan.oldName ? newPath : `${DIR}/${file}`;
    const sql = readFileSync(args.dryRun && file === plan.oldName ? oldPath : target, 'utf8');
    const lines = sql.split('\n');
    const n = headerLength(sql);
    const head = rewriteReferences(lines.slice(0, n).join('\n'), { ...refs, lines: null });
    if (head.count > 0) {
      if (!args.dryRun) writeFileSync(target, [head.text, ...lines.slice(n)].join('\n'));
      touched.add(target);
      console.log(`    ${would}update ${target} (header, ${head.count})`);
    }
    for (const [i, line] of lines.entries()) {
      if (i >= n && rewriteReferences(line, refs).count > 0) mentions.push(`${target}:${i + 1}`);
    }
  }

  for (const file of referenceFiles()) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes(plan.from)) continue;
    const result = rewriteReferences(text, { ...refs, lines: branchLines(args.base, file) });
    if (result.count === 0) continue;
    touched.add(file);
    if (!args.dryRun) writeFileSync(file, result.text);
    console.log(`    ${would}update ${file} (${result.count})`);
  }

  // Outside what this rewrites, a reader should still look at: the old file name anywhere,
  // and the old number on any line this branch added (a comment in src/, a test).
  const others = new Set(
    [
      ...gitList(['grep', '--untracked', '-l', '-F', '-e', refs.oldStem, '--', '.']),
      ...gitList(['diff', '--name-only', args.base]),
      ...gitList(['ls-files', '--others', '--exclude-standard']),
    ].filter((f) => !touched.has(f) && !f.startsWith(`${DIR}/`) && existsSync(f)),
  );
  for (const file of [...others].sort()) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes(plan.from) || text.includes('\0')) continue;
    const lines = branchLines(args.base, file);
    for (const [i, line] of text.split('\n').entries()) {
      const ours = lines === null || lines.has(i + 1);
      const hit = rewriteReferences(line, { ...refs, lines: ours ? null : new Set() });
      if (hit.count > 0) mentions.push(`${file}:${i + 1}`);
    }
  }
  if (mentions.length > 0) {
    console.log(`  ! not rewritten, still naming ${plan.from} or ${refs.oldStem} (check by hand):`);
    for (const mention of mentions) console.log(`      ${mention}`);
  }
  if (!args.dryRun) console.log('  then: node scripts/check-migrations.mjs ' + args.base);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`  ✘ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
