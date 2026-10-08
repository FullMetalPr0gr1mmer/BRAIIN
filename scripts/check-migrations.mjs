// Migration-ledger guard (CLAUDE.md §8: "Migrations forward-only, expand/contract").
//
// Enforced against the merge base, because every rule here is about what a branch does
// RELATIVE TO what production may already have applied:
//
//   1. names are `NNNN_snake_case.sql`;
//   2. no two files share a number;
//   3. a migration that exists on the base branch is never modified, renamed or deleted —
//      production has (or will have) applied it, so an edit forks history silently;
//   4. every NEW migration numbers strictly above the base branch's highest.
//
// Rule 4 is the one that bites in parallel work: two branches each adding "0016_…" both
// pass on their own and collide on merge, and `supabase db push` rejects an out-of-order
// history unless forced with --include-all. The fix is to renumber before merge, which is
// cheap at review time and expensive after one of them has been applied.
//
//   node scripts/check-migrations.mjs            # base = origin/main
//   node scripts/check-migrations.mjs origin/x   # explicit base

import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

const DIR = 'supabase/migrations';
const NAME = /^(\d{4})_[a-z0-9_]+\.sql$/;
const base =
  process.argv[2] ??
  (process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : 'origin/main');

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

let baseFiles;
try {
  baseFiles = git('ls-tree', '--name-only', `${base}:${DIR}`).split('\n').filter(Boolean);
} catch {
  console.error(
    `  ✘ cannot read ${DIR} at ${base} — fetch it first (actions/checkout fetch-depth: 0).`,
  );
  process.exit(1);
}

const headFiles = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const problems = [];

// 1 + 2: shape and uniqueness, over the whole ledger.
const byNumber = new Map();
for (const f of headFiles) {
  const m = NAME.exec(f);
  if (!m) {
    problems.push(`${f}: name must match NNNN_snake_case.sql`);
    continue;
  }
  const n = m[1];
  if (byNumber.has(n)) problems.push(`${f}: number ${n} already used by ${byNumber.get(n)}`);
  else byNumber.set(n, f);
}

// 3: forward-only. Compare the base's committed files with the working tree.
const changed = git('diff', '--name-status', base, '--', DIR)
  .split('\n')
  .filter(Boolean)
  .map((line) => line.split('\t'));
const baseSet = new Set(baseFiles);
for (const [status, ...paths] of changed) {
  const original = paths[0].split('/').pop();
  if (baseSet.has(original) && !status.startsWith('A')) {
    problems.push(
      `${original}: ${status.startsWith('D') ? 'deleted' : status.startsWith('R') ? 'renamed' : 'modified'} — ` +
        'migrations on the base branch are immutable; write a new forward migration instead',
    );
  }
}

// 4: new files number above the base's maximum.
const baseMax = Math.max(0, ...baseFiles.map((f) => Number(NAME.exec(f)?.[1] ?? 0)));
for (const f of headFiles) {
  if (baseSet.has(f) || !NAME.test(f)) continue; // bad names are already reported by rule 1
  const n = Number(NAME.exec(f)?.[1]);
  if (!(n > baseMax)) {
    problems.push(
      `${f}: new migration must number above ${String(baseMax).padStart(4, '0')} (the highest on ${base})`,
    );
  }
}

if (problems.length) {
  console.error(`  ✘ migration ledger (base ${base}):`);
  for (const p of problems) console.error(`    - ${p}`);
  console.error(
    `    a new migration numbered too low: merge ${base} in, then ` +
      `node scripts/renumber-migration.mjs <file> --base ${base}`,
  );
  process.exit(1);
}
const added = headFiles.filter((f) => !baseSet.has(f));
console.log(
  `  ✓ migration ledger ok — ${headFiles.length} files, highest on ${base} is ${String(baseMax).padStart(4, '0')}` +
    (added.length ? `, adding ${added.join(', ')}` : ', no new migrations'),
);
