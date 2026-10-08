// Renumber a branch's NEW migration above the base branch's highest: the fix that
// scripts/check-migrations.mjs (rule 4) asks for when another branch merged the same
// number first.
//
// Migrations apply in number order, and a file on the base branch is immutable (production
// may have applied it), so the branch that lands second moves its own file up. By hand that
// is a rename plus every place the old name is written down. This does both:
//
//   1. refuses a file that exists on the base, and a branch that has not merged the base
//      (below);
//   2. renames the file with `git mv` to the lowest number above both the base's highest
//      and this branch's earlier new migrations, passing over any number the reservation
//      ledger (docs/admin-v2/migrations.md, "Reserved") holds for another slice, so that
//      slice keeps it if it merges first. A file only ever moves up: one that
//      check-migrations already accepts stays where it is, gap or not, because the number
//      below it may be another slice's. Several new migrations on one branch keep their
//      order: a move that would jump a later one is refused, naming the one to move first;
//   3. never edits the ledger, not even a file name in it: its rows are the program's plan,
//      and a row whose file name moved while its Number cell stayed would disagree with
//      itself. Every line of it that names the old migration (by file name, by number, or
//      by a range that holds the number) is listed for a reader, who moves this slice's row
//      by hand (to take a number reserved for another slice, re-plan both rows there first);
//   4. rewrites references in supabase/tests/*.sql, docs/**/*.md (the ledger aside),
//      CLAUDE.md and the header comments of the branch's new migrations (its own, and a
//      sibling's "Depends on"). The file name (with or without `.sql`) names this migration
//      alone, so it is rewritten wherever it appears. A bare number ("0038") is rewritten
//      only where it can name nothing else: on lines this branch added (anywhere else it
//      can be the base's own words), and not on one whose base side already named 0038
//      (CLAUDE.md keeps a whole paragraph on one line). None moves at all while another
//      migration has that number, the base's own 0038 or a second new one of the branch's
//      (which keeps it): any 0038 the branch wrote may name that one;
//   5. lists every file it changed with its count of rewrites, and under it each line where
//      a bare number moved (a file name's rewrite is counted, not listed), then every line
//      it left alone that still names the old migration (a bare number that may name
//      another, the SQL under a header, a comment in src/, the ledger's rows), with the
//      reason, for a reader to check.
//
//   node scripts/renumber-migration.mjs supabase/migrations/0038_leads_write.sql
//   node scripts/renumber-migration.mjs 0038_leads_write.sql --base origin/main --dry-run
//
// Merge the base in first (git fetch origin && git merge origin/main): "lines this branch
// added" are the lines that differ from the base, so before the merge every line the base
// changed since the fork would read as this branch's, and the script refuses to run. Then
// run scripts/check-migrations.mjs.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DIR = 'supabase/migrations';
/** The ledger's file name rule, as scripts/check-migrations.mjs states it. */
export const NAME = /^(\d{4})_[a-z0-9_]+\.sql$/;
/** The program's migration reservation ledger: its "Reserved" table names each number's slice. */
export const LEDGER = 'docs/admin-v2/migrations.md';

const USAGE = 'usage: node scripts/renumber-migration.mjs <file> [--base origin/main] [--dry-run]';

const pad = (/** @type {number} */ n) => String(n).padStart(4, '0');
const numberOf = (/** @type {string} */ name) => Number(NAME.exec(name)?.[1] ?? 0);
/** A bare number, not inside another token (10038, 0038abcd, 1.0038, 0038_name). */
const bareNumber = (/** @type {string} */ number, flags = '') =>
  new RegExp(`(?<![\\w.])${number}(?!\\w|\\.\\d)`, flags);
/** A migration's name without `.sql`, not inside a longer one (0038_leads, not 0038_leads_x). */
const stemName = (/** @type {string} */ stem, flags = '') =>
  new RegExp(`(?<!\\w)${stem}(?![a-z0-9_])`, flags);

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
 * the working tree's; `reserved` and `baseReserved` the reservation ledger's Reserved
 * table in the working tree and on the base (empty without a ledger). Throws, with the
 * reason, when the move is refused.
 *
 * @param {{ name: string, baseFiles: string[], headFiles: string[], base?: string, reserved?: Map<string, string>, baseReserved?: Map<string, string> }} input
 * @returns {{ from: string, to: string, oldName: string, newName: string, baseMax: string, noop: boolean, skipped: { number: string, slice: string }[] }}
 */
export function planRenumber({
  name,
  baseFiles,
  headFiles,
  base = 'the base',
  reserved = new Map(),
  baseReserved = new Map(),
}) {
  if (!NAME.test(name)) throw new Error(`${name}: not a migration name (NNNN_snake_case.sql)`);
  if (baseFiles.includes(name)) {
    throw new Error(
      `${name} exists on ${base}, and migrations there are immutable (production may have ` +
        'applied it): write a new forward migration instead',
    );
  }
  if (!headFiles.includes(name)) throw new Error(`${name}: no such file in ${DIR}`);

  // Whose a number is: the slice on its Reserved row. A file belongs to the slice its own
  // number is reserved for, read from the base's ledger too once the branch has moved that
  // row; a number reserved for that same slice is the file's to take.
  const heldByOther = (/** @type {number} */ n, /** @type {string} */ file) => {
    const holder = reserved.get(pad(n));
    const own = reserved.get(pad(numberOf(file))) ?? baseReserved.get(pad(numberOf(file)));
    return holder === own ? undefined : holder;
  };

  const baseMax = Math.max(0, ...baseFiles.filter((f) => NAME.test(f)).map(numberOf));
  // The branch's new migrations in the order they apply. Each needs a number above the
  // base's highest and above the one before it, and keeps its own when that already is: a
  // file moves only up, and only as far as it must. Closing a gap below it would take a
  // number check-migrations never asked for, possibly one reserved for another slice. A
  // number the ledger holds for another slice is passed over (its rule 3), so that slice
  // keeps it if it merges first.
  const branchNew = headFiles.filter((f) => NAME.test(f) && !baseFiles.includes(f)).sort();
  const place = branchNew.indexOf(name);
  let to = 0;
  /** @type {{ number: string, slice: string }[]} */
  let skipped = [];
  for (const file of branchNew.slice(0, place + 1)) {
    skipped = [];
    to = Math.max(numberOf(file), baseMax + 1, to + 1);
    for (let slice = heldByOther(to, file); slice !== undefined; slice = heldByOther(to, file)) {
      skipped.push({ number: pad(to), slice });
      to++;
    }
  }
  if (to > 9999) throw new Error(`${name}: no four-digit number is left above ${pad(baseMax)}`);

  const plan = {
    from: pad(numberOf(name)),
    to: pad(to),
    oldName: name,
    newName: `${pad(to)}${name.slice(4)}`,
    baseMax: pad(baseMax),
    noop: to === numberOf(name),
    skipped,
  };
  if (plan.noop) return plan;

  // The move must not carry this file past a later new migration of the branch, which has
  // to number above its new number. An earlier one cannot be in the way: it numbers no
  // higher than this file did, and this file only moves up.
  for (const other of branchNew.slice(place + 1)) {
    if (numberOf(other) <= to) {
      throw new Error(
        `${other} is new on this branch too and must stay after ${name}: renumber ${other} first`,
      );
    }
  }
  return plan;
}

/**
 * The hunks of a `git diff -U0`: the lines each one adds (1-based, in the working tree,
 * with their text) and the text of the lines it removes.
 *
 * @param {string} diff
 * @returns {{ added: Map<number, string>, removed: string[] }[]}
 */
export function hunks(diff) {
  /** @type {{ added: Map<number, string>, removed: string[] }[]} */
  const out = [];
  let next = 0;
  for (const raw of diff.split('\n')) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (header) {
      out.push({ added: new Map(), removed: [] });
      next = Number(header[1]);
      continue;
    }
    const hunk = out.at(-1);
    if (!hunk) continue; // the file header, before the first hunk
    if (raw.startsWith('+')) hunk.added.set(next++, raw.slice(1));
    else if (raw.startsWith('-')) hunk.removed.push(raw.slice(1));
  }
  return out;
}

/**
 * The line numbers (1-based, in the working tree) that `git diff -U0` reports as added.
 *
 * @param {string} diff
 * @returns {Set<number>}
 */
export function addedLines(diff) {
  return new Set(hunks(diff).flatMap((hunk) => [...hunk.added.keys()]));
}

/**
 * The added lines whose base side already named `number`: their hunk also removes a line
 * that has it. A branch that adds to a CLAUDE.md paragraph (one physical line) citing the
 * base's own 0038 leaves a line that may name both 0038s, and only a reader can tell them
 * apart.
 *
 * @param {string} diff
 * @param {string} number
 * @returns {Set<number>}
 */
export function contestedLines(diff, number) {
  const bare = bareNumber(number);
  return new Set(
    hunks(diff)
      .filter((hunk) => hunk.removed.some((text) => bare.test(text)))
      .flatMap((hunk) => [...hunk.added.keys()]),
  );
}

/**
 * Where a bare `from` may be rewritten in one text, and where it may only be reported.
 * `added` are the lines this branch added (null: the whole text is the branch's own), and
 * `contested` the added lines whose base side already named `from`. `shared` says another
 * migration has that number too (the base's own 0038, or a second new one of the branch's):
 * then any bare 0038 may name it, on whichever line, so none is rewritten.
 *
 * @param {string} text
 * @param {{ from: string, added: Set<number> | null, contested?: Set<number>, shared?: boolean }} input
 * @returns {{ rewrite: Set<number>, unsure: number[] }}
 */
export function bareTargets(text, { from, added, contested = new Set(), shared = false }) {
  const bare = bareNumber(from);
  /** @type {Set<number>} */
  const rewrite = new Set();
  /** @type {number[]} */
  const unsure = [];
  for (const [i, line] of text.split('\n').entries()) {
    const n = i + 1;
    if ((added !== null && !added.has(n)) || !bare.test(line)) continue;
    if (shared || contested.has(n)) unsure.push(n);
    else rewrite.add(n);
  }
  return { rewrite, unsure };
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
 * when `lines` is null. `bare` lists the lines where the bare number moved.
 *
 * @param {string} text
 * @param {{ from: string, to: string, oldStem: string, newStem: string, lines?: Set<number> | null }} refs
 * @returns {{ text: string, count: number, bare: number[] }}
 */
export function rewriteReferences(text, { from, to, oldStem, newStem, lines = null }) {
  // Not inside a longer name (0038_leads_write must not match 0038_leads_writer), and the
  // number not inside another token (10038, 0038abcd, 1.0038).
  const stem = stemName(oldStem, 'g');
  const bareRe = bareNumber(from, 'g');
  let count = 0;
  /** @type {number[]} */
  const bare = [];
  const out = text.split('\n').map((line, i) => {
    let next = line.replace(stem, () => {
      count++;
      return newStem;
    });
    if (lines === null || lines.has(i + 1)) {
      const before = count;
      next = next.replace(bareRe, () => {
        count++;
        return to;
      });
      if (count > before) bare.push(i + 1);
    }
    return next;
  });
  return { text: out.join('\n'), count, bare };
}

/**
 * The reservation ledger's "Reserved" table: each number → the slice it is reserved for
 * (the first word of the Slice column, without link or emphasis). A Number cell may hold
 * several numbers, or a range ("0041 to 0043"). Rows outside that section (Applied, the
 * rules) are not reservations.
 *
 * @param {string} markdown
 * @returns {Map<string, string>}
 */
export function reservations(markdown) {
  /** @type {Map<string, string>} */
  const reserved = new Map();
  let level = 0; // the "Reserved" heading's depth while inside its section, else 0
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const depth = heading[1]?.length ?? 0;
      if (/^reserved\b/i.test(heading[2] ?? '')) level = depth;
      else if (depth <= level) level = 0;
      continue;
    }
    if (!level || !line.trimStart().startsWith('|')) continue;
    const [, numbers = '', slice = ''] = line.split('|').map((cell) => cell.trim());
    const id =
      slice
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[`*]/g, '')
        .trim()
        .split(/[\s,;(]/)[0] ?? '';
    if (!id) continue;
    let listed = numbers.match(/(?<!\d)\d{4}(?!\d)/g) ?? [];
    const range = /^(\d{4})\s*(?:to|-|–|—)\s*(\d{4})$/.exec(numbers);
    if (range) {
      const [first, last] = [Number(range[1]), Number(range[2])];
      listed = Array.from({ length: Math.max(0, last - first + 1) }, (_, k) => pad(first + k));
    }
    for (const number of listed) reserved.set(number, id);
  }
  return reserved;
}

/** A range of numbers as the ledger writes one: "0041 to 0043", "0041-0043", "0041–0043". */
const RANGE = /(?<![\w.])(\d{4})\s*(?:to|-|–|—)\s*(\d{4})(?!\w|\.\d)/g;

/**
 * The reservation ledger's lines that name a migration: by its file name (with or without
 * `.sql`), by its bare number, or by a range of numbers that holds it ("0040 to 0043" is
 * also a row for 0041). The ledger is never rewritten, so these are listed for a reader.
 *
 * @param {string} markdown
 * @param {{ from: string, oldStem: string }} migration
 * @returns {number[]} the lines, 1-based
 */
export function ledgerLines(markdown, { from, oldStem }) {
  const bare = bareNumber(from);
  const stem = stemName(oldStem);
  const number = Number(from);
  const inRange = (/** @type {string} */ line) =>
    [...line.matchAll(RANGE)].some(([, a, b]) => Number(a) <= number && number <= Number(b));
  return markdown
    .split('\n')
    .flatMap((line, i) => (bare.test(line) || stem.test(line) || inRange(line) ? [i + 1] : []));
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

/** A command's output; null when it fails (a path the ref does not have). */
const gitOutput = (/** @type {string[]} */ args) => {
  try {
    return git(args);
  } catch {
    return null;
  }
};

/** A command's output lines; none when it fails (git grep exits 1 on no match). */
const gitList = (/** @type {string[]} */ args) =>
  (gitOutput(args) ?? '').split('\n').filter(Boolean);

/**
 * `git diff -U0` of `file` against the base; null when the base does not have the file at
 * all (every line is this branch's).
 *
 * @param {string} base
 * @param {string} file
 */
const branchDiff = (base, file) =>
  gitSucceeds(['cat-file', '-e', `${base}:${file}`])
    ? git(['diff', '-U0', '--no-color', '--no-ext-diff', base, '--', file])
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
  // This branch's lines are told from the base's by a diff against the base, so the base
  // must be merged in: before that, every line it changed since the fork reads as this
  // branch's, and the base's own numbers on those lines would be rewritten.
  if (!gitSucceeds(['merge-base', '--is-ancestor', args.base, 'HEAD'])) {
    throw new Error(
      `${args.base} is not merged into this branch: merge it first (git fetch origin && ` +
        `git merge ${args.base}, then commit the merge) and run this again`,
    );
  }
  const headFiles = readdirSync(DIR).filter((f) => f.endsWith('.sql'));
  // The reservation ledger hands out numbers per wave, so the next number may be another
  // slice's: the plan passes over those.
  const plan = planRenumber({
    name,
    baseFiles,
    headFiles,
    base: args.base,
    reserved: reservations(existsSync(LEDGER) ? readFileSync(LEDGER, 'utf8') : ''),
    baseReserved: reservations(gitOutput(['show', `${args.base}:${LEDGER}`]) ?? ''),
  });
  if (plan.noop) {
    console.log(
      `  ✓ ${name} already numbers above ${plan.baseMax}, the highest on ${args.base}, and ` +
        "after this branch's earlier new migrations: nothing to do",
    );
    return;
  }

  const would = args.dryRun ? 'would ' : '';
  const oldPath = `${DIR}/${plan.oldName}`;
  const newPath = `${DIR}/${plan.newName}`;
  // A name only a case-insensitive file system sees as taken (0039_X.sql) would be
  // overwritten by the rename below.
  if (existsSync(newPath)) throw new Error(`${newPath} already exists`);
  const refs = {
    from: plan.from,
    to: plan.to,
    oldStem: plan.oldName.replace(/\.sql$/, ''),
    newStem: plan.newName.replace(/\.sql$/, ''),
  };
  // Every other migration of the old number: the base's own, and a second new one of this
  // branch's (two new files that share a number are parted by moving the later one, so the
  // earlier one, its twin, keeps the number). A bare 0038 the branch wrote may name any of
  // them, so while there is one, none moves: each line naming 0038 is listed with them.
  const sameNumber = (/** @type {string} */ f) =>
    NAME.test(f) && numberOf(f) === numberOf(plan.oldName);
  const twins = headFiles.filter(
    (f) => !baseFiles.includes(f) && f !== plan.oldName && sameNumber(f),
  );
  const namesakes = [
    ...baseFiles.filter(sameNumber).map((f) => `the base's ${f.replace(/\.sql$/, '')}`),
    ...twins.map((f) => `this branch's ${f.replace(/\.sql$/, '')}`),
  ];
  const shared = namesakes.length > 0;
  const mayNameOther = `may name ${shared ? namesakes.join(' or ') : `the base's ${plan.from}`} too`;
  console.log(
    `  ✓ ${args.dryRun ? 'dry run: ' : ''}${plan.oldName} → ${plan.newName} ` +
      `(the highest on ${args.base} is ${plan.baseMax})`,
  );
  for (const { number, slice } of plan.skipped) {
    console.log(`    skipped ${number}: reserved for ${slice} in ${LEDGER}`);
  }

  const tracked = gitSucceeds(['ls-files', '--error-unmatch', '--', oldPath]);
  if (!args.dryRun) {
    if (tracked) git(['mv', '--', oldPath, newPath]);
    else renameSync(oldPath, newPath);
  }
  console.log(
    `    ${would}rename ${oldPath} → ${newPath} (${tracked ? 'git mv' : 'untracked: renamed on disk'})`,
  );

  /** @type {{ at: string, why?: string }[]} "file:line" left alone that still names the old migration */
  const mentions = [];
  /** @param {string} file @param {number[]} lines */
  const listBare = (file, lines) => {
    for (const line of lines) console.log(`      ${file}:${line}  ${plan.from} → ${plan.to}`);
  };

  // The headers of the branch's new migrations are the branch's own words: the moved
  // file's number follows there, and so does a sibling's "Depends on 0038", unless another
  // migration has that number too (a twin's header names the twin itself). The SQL below
  // a header is left alone (a number in a statement is a value, not a reference), and a
  // mention there is reported instead.
  for (const file of headFiles.filter((f) => !baseFiles.includes(f)).sort()) {
    const target = file === plan.oldName ? newPath : `${DIR}/${file}`;
    const sql = readFileSync(args.dryRun && file === plan.oldName ? oldPath : target, 'utf8');
    const lines = sql.split('\n');
    const n = headerLength(sql);
    const header = lines.slice(0, n).join('\n');
    const { rewrite, unsure } = bareTargets(header, { from: plan.from, added: null, shared });
    const head = rewriteReferences(header, { ...refs, lines: rewrite });
    if (head.count > 0) {
      if (!args.dryRun) writeFileSync(target, [head.text, ...lines.slice(n)].join('\n'));
      console.log(`    ${would}update ${target} (header, ${head.count})`);
      listBare(target, head.bare);
    }
    const why = twins.includes(file)
      ? `the header of ${file.replace(/\.sql$/, '')}, which keeps ${plan.from}`
      : mayNameOther;
    for (const line of unsure) mentions.push({ at: `${target}:${line}`, why });
    for (const [i, line] of lines.entries()) {
      if (i >= n && rewriteReferences(line, refs).count > 0)
        mentions.push({ at: `${target}:${i + 1}` });
    }
  }

  const refFiles = referenceFiles();
  for (const file of refFiles) {
    const text = readFileSync(file, 'utf8');
    // The ledger's rows are the program's plan, written on the base, so this slice's row
    // still carries the old number: only a reader can move it (to the new number, or to
    // "Applied" once production has the migration), and tell it from another slice's. So
    // nothing in it is rewritten, not even a file name (the row would then name the new
    // file under the old number), and every line naming the old migration is listed.
    if (file === LEDGER) {
      for (const line of ledgerLines(text, refs)) {
        mentions.push({ at: `${file}:${line}`, why: 'the reservation ledger: rows move by hand' });
      }
      continue;
    }
    if (!text.includes(plan.from)) continue;
    const diff = branchDiff(args.base, file);
    const { rewrite, unsure } = bareTargets(text, {
      from: plan.from,
      added: diff === null ? null : addedLines(diff),
      contested: diff === null ? new Set() : contestedLines(diff, plan.from),
      shared,
    });
    const result = rewriteReferences(text, { ...refs, lines: rewrite });
    if (result.count > 0) {
      if (!args.dryRun) writeFileSync(file, result.text);
      console.log(`    ${would}update ${file} (${result.count})`);
      listBare(file, result.bare);
    }
    for (const line of unsure) mentions.push({ at: `${file}:${line}`, why: mayNameOther });
  }

  // Outside what this rewrites, a reader should still look at: the old file name anywhere,
  // and the old number on any line this branch added (a comment in src/, a test).
  const others = new Set(
    [
      ...gitList(['grep', '--untracked', '-l', '-F', '-e', refs.oldStem, '--', '.']),
      ...gitList(['diff', '--name-only', args.base]),
      ...gitList(['ls-files', '--others', '--exclude-standard']),
    ].filter((f) => !refFiles.includes(f) && !f.startsWith(`${DIR}/`) && existsSync(f)),
  );
  for (const file of [...others].sort()) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes(plan.from) || text.includes('\0')) continue;
    const diff = branchDiff(args.base, file);
    const lines = diff === null ? null : addedLines(diff);
    for (const [i, line] of text.split('\n').entries()) {
      const ours = lines === null || lines.has(i + 1);
      const hit = rewriteReferences(line, { ...refs, lines: ours ? null : new Set() });
      if (hit.count > 0) mentions.push({ at: `${file}:${i + 1}` });
    }
  }
  if (mentions.length > 0) {
    console.log(`  ! not rewritten, still naming ${plan.from} or ${refs.oldStem} (check by hand):`);
    for (const { at, why } of mentions) console.log(`      ${at}${why ? `  ${why}` : ''}`);
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
