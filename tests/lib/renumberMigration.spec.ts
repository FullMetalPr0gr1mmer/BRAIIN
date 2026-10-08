import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as R from '../../scripts/renumber-migration.mjs';

// scripts/renumber-migration.mjs moves a branch's new migration above the base branch's
// highest when another branch merged the same number first (check-migrations rule 4). The
// rename is the easy half; these pin the other half too: a file on the base is never
// touched, a file only ever moves up, a branch's several new migrations keep their order, a
// number the reservation ledger holds for another slice is passed over, and a bare number is
// rewritten only where this branch wrote it and it cannot mean the base's own one (a line
// that may name both is listed for a reader instead).

const {
  addedLines,
  bareTargets,
  contestedLines,
  headerLength,
  parseArgs,
  planRenumber,
  reservations,
  rewriteReferences,
} = R;

describe('parseArgs', () => {
  it('takes one file, origin/main as the default base, and --dry-run', () => {
    expect(parseArgs(['0038_a.sql'])).toEqual({
      file: '0038_a.sql',
      base: 'origin/main',
      dryRun: false,
    });
    expect(parseArgs(['--dry-run', '--base', 'origin/x', 'f.sql'])).toEqual({
      file: 'f.sql',
      base: 'origin/x',
      dryRun: true,
    });
    expect(parseArgs(['f.sql', '--base=main']).base).toBe('main');
  });

  it('refuses no file, two files, an unknown option and a --base without a ref', () => {
    expect(() => parseArgs([])).toThrow(/usage/);
    expect(() => parseArgs(['a.sql', 'b.sql'])).toThrow(/one migration at a time/);
    expect(() => parseArgs(['a.sql', '--force'])).toThrow(/unknown option --force/);
    expect(() => parseArgs(['a.sql', '--base'])).toThrow(/usage/);
  });
});

describe('planRenumber', () => {
  const base = ['0036_a.sql', '0037_b.sql'];

  it('moves a new migration to the next number above the base’s highest', () => {
    expect(
      planRenumber({
        name: '0037_mine.sql',
        baseFiles: base,
        headFiles: [...base, '0037_mine.sql'],
      }),
    ).toEqual({
      from: '0037',
      to: '0038',
      oldName: '0037_mine.sql',
      newName: '0038_mine.sql',
      baseMax: '0037',
      noop: false,
      skipped: [],
    });
  });

  it('is a no-op when the file already numbers next above the base', () => {
    const plan = planRenumber({
      name: '0038_mine.sql',
      baseFiles: base,
      headFiles: [...base, '0038_mine.sql'],
    });
    expect(plan.noop).toBe(true);
  });

  it('never moves a file down: one check-migrations accepts stays, gap or not', () => {
    // 0040 is above the base's 0037, so check-migrations accepts it. Closing the gap would
    // take 0038 or 0039, numbers the reservation ledger may have given other slices.
    expect(
      planRenumber({
        name: '0040_mine.sql',
        baseFiles: base,
        headFiles: [...base, '0040_mine.sql'],
      }).noop,
    ).toBe(true);
    const headFiles = [...base, '0039_a.sql', '0041_b.sql'];
    expect(planRenumber({ name: '0039_a.sql', baseFiles: base, headFiles }).noop).toBe(true);
    expect(planRenumber({ name: '0041_b.sql', baseFiles: base, headFiles }).noop).toBe(true);
  });

  it('refuses a file on the base, a missing file and a bad name', () => {
    expect(() =>
      planRenumber({ name: '0037_b.sql', baseFiles: base, headFiles: base, base: 'origin/main' }),
    ).toThrow(/0037_b\.sql exists on origin\/main, and migrations there are immutable/);
    expect(() => planRenumber({ name: '0039_gone.sql', baseFiles: base, headFiles: base })).toThrow(
      /no such file/,
    );
    expect(() => planRenumber({ name: '39_x.sql', baseFiles: base, headFiles: base })).toThrow(
      /not a migration name/,
    );
  });

  // Two new migrations on one branch (C10a has two) land as the base's highest +1 and +2,
  // in order, however the base caught up with them.
  it.each([
    // the base took 0038 only: the second must move out of the first one's way
    [['0038_x.sql'], ['0039_first.sql', '0040_second.sql']],
    // the base took both numbers: both move up two
    [
      ['0038_x.sql', '0039_y.sql'],
      ['0040_first.sql', '0041_second.sql'],
    ],
  ])('keeps a branch’s new migrations in order (base adds %j)', (added, expected) => {
    const baseFiles = [...base, ...added];
    const head = [...baseFiles, '0038_first.sql', '0039_second.sql'];
    // The first cannot move while the second is in its way, and says which to move.
    expect(() => planRenumber({ name: '0038_first.sql', baseFiles, headFiles: head })).toThrow(
      /0039_second\.sql is new on this branch too and must stay after 0038_first\.sql: renumber 0039_second\.sql first/,
    );
    const second = planRenumber({ name: '0039_second.sql', baseFiles, headFiles: head }).newName;
    const moved = head.map((f) => (f === '0039_second.sql' ? second : f));
    const first = planRenumber({ name: '0038_first.sql', baseFiles, headFiles: moved }).newName;
    expect([first, second]).toEqual(expected);
  });

  it('moves a later migration up only as far as an earlier one needs', () => {
    // 0039_a must clear the base's 0040, and 0041 is the only number between them: 0041_b
    // moves up to 0042 first. With room to spare, it stays.
    const baseFiles = ['0040_x.sql'];
    const headFiles = [...baseFiles, '0039_a.sql', '0041_b.sql'];
    expect(() => planRenumber({ name: '0039_a.sql', baseFiles, headFiles })).toThrow(
      /renumber 0041_b\.sql first/,
    );
    expect(planRenumber({ name: '0041_b.sql', baseFiles, headFiles }).newName).toBe('0042_b.sql');
    const roomy = [...baseFiles, '0039_a.sql', '0045_b.sql'];
    expect(planRenumber({ name: '0045_b.sql', baseFiles, headFiles: roomy }).noop).toBe(true);
    expect(planRenumber({ name: '0039_a.sql', baseFiles, headFiles: roomy }).newName).toBe(
      '0041_a.sql',
    );
  });

  it('parts two new migrations that share a number by moving the later one up', () => {
    const baseFiles = ['0038_x.sql'];
    const headFiles = [...baseFiles, '0040_a.sql', '0040_b.sql'];
    expect(planRenumber({ name: '0040_a.sql', baseFiles, headFiles }).noop).toBe(true);
    expect(planRenumber({ name: '0040_b.sql', baseFiles, headFiles }).newName).toBe('0041_b.sql');
  });
});

describe('planRenumber and the reservation ledger', () => {
  // The ledger planned 0038 for C3, 0039 for U3, 0040 for R1 and 0041 for R2. U3 merged
  // first, so C3's 0038 must move above 0039.
  const baseFiles = ['0037_b.sql', '0039_u3.sql'];
  const headFiles = [...baseFiles, '0038_c3.sql'];
  const ledger = new Map([
    ['0038', 'C3'],
    ['0040', 'R1'],
    ['0041', 'R2'],
  ]);

  it('passes over the numbers held for other slices, and says which', () => {
    expect(
      planRenumber({ name: '0038_c3.sql', baseFiles, headFiles, reserved: ledger }),
    ).toMatchObject({
      newName: '0042_c3.sql',
      skipped: [
        { number: '0040', slice: 'R1' },
        { number: '0041', slice: 'R2' },
      ],
    });
  });

  it('takes a number held for its own slice', () => {
    // C3 planned 0038 and 0040, so 0040 is C3's to take.
    const own = new Map([
      ['0038', 'C3'],
      ['0040', 'C3'],
      ['0041', 'R1'],
    ]);
    expect(
      planRenumber({ name: '0038_c3.sql', baseFiles, headFiles, reserved: own }),
    ).toMatchObject({
      newName: '0040_c3.sql',
      skipped: [],
    });
  });

  it('takes the number the branch re-planned for it, reading whose the old one was from the base', () => {
    // On the branch, C3's row now holds 0040 and R1's moved to 0042; the base still says
    // 0038 was C3's.
    const replanned = new Map([
      ['0040', 'C3'],
      ['0041', 'R2'],
      ['0042', 'R1'],
    ]);
    expect(
      planRenumber({
        name: '0038_c3.sql',
        baseFiles,
        headFiles,
        reserved: replanned,
        baseReserved: ledger,
      }),
    ).toMatchObject({ newName: '0040_c3.sql', skipped: [] });
  });

  it('counts every reserved number as someone else’s when its own had no row', () => {
    expect(
      planRenumber({
        name: '0038_c3.sql',
        baseFiles,
        headFiles,
        reserved: new Map([['0040', 'R1']]),
      }),
    ).toMatchObject({ newName: '0041_c3.sql', skipped: [{ number: '0040', slice: 'R1' }] });
  });

  it('keeps a branch’s migrations in order around the numbers it passes over', () => {
    // C3 planned 0038 and 0039, R1 0041 and R2 0042; U3 merged its 0040 first. The later
    // file moves first, then the earlier one fits below it, passing over R1's and R2's.
    const base = ['0037_b.sql', '0040_u3.sql'];
    const plan = new Map([
      ['0038', 'C3'],
      ['0039', 'C3'],
      ['0041', 'R1'],
      ['0042', 'R2'],
    ]);
    const head = [...base, '0038_c3.sql', '0039_c3_more.sql'];
    const move = (name: string, headFiles: string[]) =>
      planRenumber({ name, baseFiles: base, headFiles, reserved: plan });
    expect(() => move('0038_c3.sql', head)).toThrow(/renumber 0039_c3_more\.sql first/);
    const later = move('0039_c3_more.sql', head);
    expect(later.newName).toBe('0044_c3_more.sql');
    const moved = head.map((f) => (f === '0039_c3_more.sql' ? later.newName : f));
    expect(move('0038_c3.sql', moved)).toMatchObject({
      newName: '0043_c3.sql',
      skipped: [
        { number: '0041', slice: 'R1' },
        { number: '0042', slice: 'R2' },
      ],
    });
  });
});

describe('addedLines and contestedLines', () => {
  const diff = [
    'diff --git a/docs/x.md b/docs/x.md',
    '--- a/docs/x.md',
    '+++ b/docs/x.md',
    '@@ -3,0 +4,2 @@ ## Reserved',
    '+one 0038',
    '+two',
    '@@ -9 +11 @@',
    '-the base’s paragraph cites 0038.',
    '+the base’s paragraph cites 0038. Ours is 0038.',
    '@@ -20,2 +21,0 @@',
    '-gone',
    '-and 0038',
  ].join('\n');

  it('reads the added side of every -U0 hunk', () => {
    expect([...addedLines(diff)]).toEqual([4, 5, 11]);
    expect(addedLines('').size).toBe(0);
  });

  it('contests the added lines whose hunk also removes a line naming the number', () => {
    // Line 11 replaced a line that already cited 0038. Lines 4 and 5 replaced nothing, and
    // the last hunk removes a 0038 line but adds none.
    expect([...contestedLines(diff, '0038')]).toEqual([11]);
    expect(contestedLines(diff, '0039').size).toBe(0);
  });
});

describe('headerLength', () => {
  it('counts the comment and blank lines before the first statement', () => {
    expect(headerLength('-- 0038 — x\r\n--\r\n\r\ncreate table t ();\n-- later\n')).toBe(3);
    expect(headerLength('create table t ();')).toBe(0);
  });
});

describe('rewriteReferences', () => {
  const refs = { from: '0038', to: '0039', oldStem: '0038_leads', newStem: '0039_leads' };

  it('rewrites the file name everywhere, with or without .sql', () => {
    const text = 'see 0038_leads.sql\nand `0038_leads` here';
    expect(rewriteReferences(text, { ...refs, lines: new Set<number>() })).toEqual({
      text: 'see 0039_leads.sql\nand `0039_leads` here',
      count: 2,
      bare: [],
    });
  });

  it('rewrites the bare number only on the given lines, and says which', () => {
    const text = '- 0038 — the base’s own\n- 0038 — ours (0038_leads.sql)';
    expect(rewriteReferences(text, { ...refs, lines: new Set([2]) })).toEqual({
      text: '- 0038 — the base’s own\n- 0039 — ours (0039_leads.sql)',
      count: 2,
      bare: [2],
    });
  });

  it('leaves the number inside other tokens alone', () => {
    const text =
      '0038_leads_writer.sql 10038 0038abc 1.0038 x0038 ' +
      "0038's (0038) 0037–0038, 0038. 0038.sql end 0038";
    expect(rewriteReferences(text, refs).text).toBe(
      '0038_leads_writer.sql 10038 0038abc 1.0038 x0038 ' +
        "0039's (0039) 0037–0039, 0039. 0039.sql end 0039",
    );
  });
});

describe('bareTargets', () => {
  const text = [
    '0038 is ours', // 1: added, and only ours
    'the base’s 0038', // 2: not added
    'the base’s 0038; ours, 0038', // 3: added, but its base side named 0038 too
    'runs after 0038_other (0038)', // 4: added, and names the base's 0038 by file name
    '0038_leads, by name only', // 5: added, no bare number
  ].join('\n');

  it('rewrites a bare number only on added lines that cannot mean the base’s own', () => {
    const { rewrite, unsure } = bareTargets(text, {
      from: '0038',
      added: new Set([1, 3, 4, 5]),
      contested: new Set([3]),
      baseStems: ['0038_other'],
    });
    expect([...rewrite]).toEqual([1]);
    expect(unsure).toEqual([3, 4]);
  });

  it('takes every line as the branch’s when the base has no such file', () => {
    const { rewrite, unsure } = bareTargets(text, {
      from: '0038',
      added: null,
      baseStems: ['0038_other'],
    });
    expect([...rewrite]).toEqual([1, 2, 3]);
    expect(unsure).toEqual([4]);
  });
});

describe('reservations', () => {
  const ledger = [
    '# Migration ledger',
    '',
    '## Applied',
    '',
    '| Migration | What | PR |',
    '|---|---|---|',
    '| 0037 | `0037_partition_rls.sql`: RLS on every partition | #51 |',
    '',
    '## Reserved',
    '',
    '| Number | Slice | What | Wave |',
    '|---|---|---|---|',
    '| 0038 | C3 | the leads write API | 1 |',
    '| 0039 | [U3](../ui.md#u3) | uploads | 1 |',
    '| 0040 to 0041 | **C10a** (A, then B) | the Sales role | 5 |',
    '| (none yet) | | | |',
    '',
    '### Later waves',
    '',
    '| `0042` | R1 | the release ledger | 1 |',
    '',
    '## Rules',
    '',
    '| 0050 | X | an example, not a reservation | |',
  ].join('\r\n');

  it('maps each reserved number to its slice, and reads nothing outside that section', () => {
    expect(Object.fromEntries(reservations(ledger))).toEqual({
      '0038': 'C3',
      '0039': 'U3',
      '0040': 'C10a',
      '0041': 'C10a',
      '0042': 'R1',
    });
    expect(reservations('# Notes\n\n| 0038 | C3 |\n').size).toBe(0);
  });
});

// ── End to end, in throwaway repositories ─────────────────────────────────────────

const SCRIPT = resolve('scripts/renumber-migration.mjs');
const CHECK = resolve('scripts/check-migrations.mjs');

/**
 * A throwaway repository to run the scripts in. Every GIT_* variable is dropped from the
 * environment first: git exports GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE to its hooks,
 * so a run started from a hook would otherwise point each command here at the real
 * repository. The machine's own git config is kept out too, so no hook, signing rule or
 * line-ending setting can change the outcome.
 */
function throwaway(prefix: string) {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  const config = `${repo}.gitconfig`;
  writeFileSync(config, '');
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key))),
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.test',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.test',
  };
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' });
  return {
    git,
    write(path: string, text: string) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), text);
    },
    read: (path: string) => readFileSync(join(repo, path), 'utf8'),
    exists: (path: string) => existsSync(join(repo, path)),
    run(script: string, ...args: string[]) {
      try {
        const out = execFileSync(process.execPath, [script, ...args], {
          cwd: repo,
          env,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { code: 0, out };
      } catch (err) {
        const e = err as { status: number; stdout: string; stderr: string };
        return { code: e.status, out: `${e.stdout}${e.stderr}` };
      }
    },
    init() {
      git('init', '-q', '-b', 'main');
      // Every command here acts on this repository, whatever the caller's environment held.
      expect(realpathSync.native(git('rev-parse', '--absolute-git-dir').trim())).toBe(
        realpathSync.native(join(repo, '.git')),
      );
    },
    cleanup() {
      rmSync(repo, { recursive: true, force: true });
      rmSync(config, { force: true });
    },
  };
}

// main adds 0002_other while a branch adds 0002_feature and 0003_more. The branch merges
// main, then adds to main's lines as a branch does after a merge (one CLAUDE.md paragraph
// ends up naming both 0002s, two notes name main's by its file name), and moves both of
// its migrations up, the later one first.

const LEDGER = '# Ledger\n\n## Merged\n\n- 0001 — init\n\n## Reserved\n\n- none yet\n';
const STANDARD = '# Standard\n\nMigrations are forward-only.\n\n## Lanes\n';
const FEATURE =
  '-- ──────\n-- 0002 — the feature. Depends on 0001.\n--\n\n' +
  "create table feature ();\ncomment on table feature is 'added by 0002';\n";
// After the merge the branch notes that it runs after main's 0002, on line 3 of its header.
const FEATURE_MERGED = FEATURE.replace(
  '--\n\n',
  "-- Runs after 0002_other (0002), main's.\n--\n\n",
);
const MORE = '-- 0003 — more. Depends on 0002_feature (0002).\n\nselect 1;\n';

// Each step spawns git and node several times: slow on a busy runner, never wrong.
describe('renumber-migration, end to end', { timeout: 30_000 }, () => {
  let t: ReturnType<typeof throwaway>;

  beforeAll(() => {
    t = throwaway('renumber-');
    t.init();
    t.write('supabase/migrations/0001_init.sql', '-- 0001 — init\n\ncreate table t ();\n');
    t.write('supabase/tests/init.test.sql', '-- 0001 and 0002 belong to main\nselect 1;\n');
    t.write('docs/ledger.md', LEDGER);
    t.write('CLAUDE.md', STANDARD);
    t.write('src/feature.ts', '// 0002 belongs to main\n');
    t.git('add', '-A');
    t.git('commit', '-q', '-m', 'base');

    t.git('checkout', '-q', '-b', 'work');
    t.write('supabase/migrations/0002_feature.sql', FEATURE);
    t.write('supabase/migrations/0003_more.sql', MORE);
    t.write(
      'supabase/tests/feature.test.sql',
      '-- pgTAP for 0002_feature.sql (0002) and 0003_more.sql\nselect 1;\n',
    );
    t.write(
      'docs/ledger.md',
      LEDGER.replace('- none yet', '- 0002 — feature (0002_feature.sql), 0003 — more'),
    );
    t.write('docs/as-built/feature.md', '# Feature\n\nShips 0002 and 0003.\n');
    t.write('CLAUDE.md', `${t.read('CLAUDE.md')}- 0002_feature adds the feature table.\n`);
    t.write('src/feature.ts', `${t.read('src/feature.ts')}// reads the 0002 table\n`);
    t.git('add', '-A');
    t.git('commit', '-q', '-m', 'feature');
    // The branch as it was before it merged main, for the refusal below.
    t.git('branch', 'stale');

    t.git('checkout', '-q', 'main');
    t.write('supabase/migrations/0002_other.sql', '-- 0002 — other\n\nselect 1;\n');
    t.write('docs/ledger.md', LEDGER.replace('- 0001 — init\n', '- 0001 — init\n- 0002 — other\n'));
    t.write('CLAUDE.md', STANDARD.replace('forward-only.', 'forward-only; 0002 adds other.'));
    t.git('add', '-A');
    t.git('commit', '-q', '-m', 'other');

    t.git('checkout', '-q', 'work');
    t.git('merge', '-q', '--no-edit', 'main');
    t.write(
      'CLAUDE.md',
      t.read('CLAUDE.md').replace('0002 adds other.', '0002 adds other; 0002 adds the feature.'),
    );
    t.write('supabase/migrations/0002_feature.sql', FEATURE_MERGED);
    t.write(
      'docs/as-built/feature.md',
      `${t.read('docs/as-built/feature.md')}Runs after 0002_other (0002).\n`,
    );
    t.git('add', '-A');
    t.git('commit', '-q', '-m', 'after the merge');
  }, 60_000);

  afterAll(() => t?.cleanup());

  it('check-migrations fails on the clash and points at this script', () => {
    const result = t.run(CHECK, 'main');
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/number 0002 already used/);
    expect(result.out).toContain(
      'merge main in, then node scripts/renumber-migration.mjs <file> --base main',
    );
  });

  it('refuses a branch that has not merged the base, and changes nothing', () => {
    // Unmerged, every line main changed since the fork would read as the branch's, and
    // main's own 0002 on them would be rewritten.
    t.git('checkout', '-q', 'stale');
    try {
      const result = t.run(SCRIPT, 'supabase/migrations/0003_more.sql', '--base', 'main');
      expect(result.code).toBe(1);
      expect(result.out).toMatch(/main is not merged into this branch: merge it first/);
      expect(t.git('status', '--porcelain')).toBe('');
    } finally {
      // Forced, so a run that wrongly went ahead cannot carry its rename into the tests below.
      t.git('checkout', '-q', '-f', 'work');
    }
  });

  it('refuses a migration that is on the base, and a move out of order', () => {
    const onBase = t.run(SCRIPT, 'supabase/migrations/0002_other.sql', '--base', 'main');
    expect(onBase.code).toBe(1);
    expect(onBase.out).toMatch(
      /0002_other\.sql exists on main, and migrations there are immutable/,
    );
    const early = t.run(SCRIPT, 'supabase/migrations/0002_feature.sql', '--base', 'main');
    expect(early.code).toBe(1);
    expect(early.out).toMatch(/renumber 0003_more\.sql first/);
  });

  it('a dry run lists the changes and makes none', () => {
    const before = t.git('status', '--porcelain');
    const result = t.run(
      SCRIPT,
      'supabase/migrations/0003_more.sql',
      '--base',
      'main',
      '--dry-run',
    );
    expect(result.code).toBe(0);
    expect(result.out).toContain(
      'would rename supabase/migrations/0003_more.sql → supabase/migrations/0004_more.sql',
    );
    expect(result.out).toContain(
      'would update docs/ledger.md (1)\n      docs/ledger.md:10  0003 → 0004\n',
    );
    expect(t.git('status', '--porcelain')).toBe(before);
    expect(t.exists('supabase/migrations/0003_more.sql')).toBe(true);
  });

  it('renames with git mv, rewrites the references, and lists every file and line', () => {
    const more = t.run(SCRIPT, 'supabase/migrations/0003_more.sql', '--base', 'main');
    expect(more.code, more.out).toBe(0);
    const result = t.run(SCRIPT, 'supabase/migrations/0002_feature.sql', '--base', 'main');
    expect(result.code, result.out).toBe(0);

    expect(t.git('diff', '--cached', '--name-status')).toMatch(
      /^R\d*\tsupabase\/migrations\/0002_feature\.sql\tsupabase\/migrations\/0003_feature\.sql$/m,
    );
    // Its header follows, but not the line naming main's 0002; the SQL under the header is
    // a value, so it is reported, not rewritten.
    expect(t.read('supabase/migrations/0003_feature.sql')).toBe(
      FEATURE_MERGED.replace('-- 0002 — the feature', '-- 0003 — the feature'),
    );
    // A sibling's header names it too.
    expect(t.read('supabase/migrations/0004_more.sql')).toBe(
      '-- 0004 — more. Depends on 0003_feature (0003).\n\nselect 1;\n',
    );
    expect(t.read('supabase/tests/feature.test.sql')).toBe(
      '-- pgTAP for 0003_feature.sql (0003) and 0004_more.sql\nselect 1;\n',
    );
    expect(t.read('supabase/tests/init.test.sql')).toBe(
      '-- 0001 and 0002 belong to main\nselect 1;\n',
    );
    // The ledger line about main's own 0002 is the base's: untouched.
    expect(t.read('docs/ledger.md')).toBe(
      LEDGER.replace('- 0001 — init\n', '- 0001 — init\n- 0002 — other\n').replace(
        '- none yet',
        '- 0003 — feature (0003_feature.sql), 0004 — more',
      ),
    );
    expect(t.read('docs/as-built/feature.md')).toBe(
      '# Feature\n\nShips 0003 and 0004.\nRuns after 0002_other (0002).\n',
    );
    // The paragraph that names both 0002s keeps both; the file name is the branch's alone.
    expect(t.read('CLAUDE.md')).toBe(
      STANDARD.replace('forward-only.', 'forward-only; 0002 adds other; 0002 adds the feature.') +
        '- 0003_feature adds the feature table.\n',
    );

    for (const [file, bareLine] of [
      [
        'supabase/migrations/0003_feature.sql (header, 1)',
        'supabase/migrations/0003_feature.sql:2',
      ],
      ['supabase/migrations/0004_more.sql (header, 2)', 'supabase/migrations/0004_more.sql:1'],
      ['supabase/tests/feature.test.sql (2)', 'supabase/tests/feature.test.sql:1'],
      ['docs/ledger.md (2)', 'docs/ledger.md:10'],
      ['docs/as-built/feature.md (1)', 'docs/as-built/feature.md:3'],
    ]) {
      expect(result.out).toContain(`update ${file}\n      ${bareLine}  0002 → 0003\n`);
    }
    // CLAUDE.md's one rewrite is the file name, so no bare line follows it.
    expect(result.out).toContain('update CLAUDE.md (1)\n    ');
    expect(result.out).not.toContain('update supabase/tests/init.test.sql');
    // Left alone and listed for a reader: the lines that may name main's 0002, the SQL, and
    // the comment this branch wrote in src/ (not main's line above it).
    expect(result.out).toContain(
      [
        '  ! not rewritten, still naming 0002 or 0002_feature (check by hand):',
        "      supabase/migrations/0003_feature.sql:3  may name the base's 0002 too",
        '      supabase/migrations/0003_feature.sql:7',
        "      CLAUDE.md:3  may name the base's 0002 too",
        "      docs/as-built/feature.md:4  may name the base's 0002 too",
        '      src/feature.ts:2',
        '',
      ].join('\n'),
    );
    expect(t.read('src/feature.ts')).toBe('// 0002 belongs to main\n// reads the 0002 table\n');

    expect(t.run(CHECK, 'main').code).toBe(0);
  });

  it('is a no-op once the file is in place', () => {
    const result = t.run(SCRIPT, 'supabase/migrations/0003_feature.sql', '--base', 'main');
    expect(result.code).toBe(0);
    expect(result.out).toContain('nothing to do');
  });
});

// The reservation ledger gives 0002 to C3, 0003 to U3 and 0004 to R1. U3 merges first, so
// C3's 0002 must move above 0003, and the next number is R1's: C3 passes over it (the
// ledger's rule 3), so R1 keeps 0004 if it merges before C3.

const LEDGER_PATH = 'docs/admin-v2/migrations.md';
const RESERVED = [
  '# Migration ledger',
  '',
  '## Applied',
  '',
  '| Migration | What | PR |',
  '|---|---|---|',
  '| 0001 | `0001_init.sql` | #1 |',
  '',
  '## Reserved',
  '',
  '| Number | Slice | What | Wave |',
  '|---|---|---|---|',
  '| 0002 | C3 | the leads write API | 1 |',
  '| 0003 | U3 | uploads | 1 |',
  '| 0004 | R1 | the release ledger | 1 |',
  '',
].join('\n');
const C3_ROW = '| 0002 | C3 | the leads write API | 1 |';
// U3's PR moved its row to Applied before it merged.
const U3_MERGED = RESERVED.replace('| 0003 | U3 | uploads | 1 |\n', '').replace(
  '| 0001 | `0001_init.sql` | #1 |\n',
  '| 0001 | `0001_init.sql` | #1 |\n| 0003 | `0003_uploads.sql` | #3 |\n',
);

describe('renumber-migration and the reservation ledger', { timeout: 30_000 }, () => {
  let t: ReturnType<typeof throwaway>;

  beforeAll(() => {
    t = throwaway('renumber-ledger-');
    t.init();
    t.write('supabase/migrations/0001_init.sql', '-- 0001 — init\n\ncreate table t ();\n');
    t.write(LEDGER_PATH, RESERVED);
    t.git('add', '-A');
    t.git('commit', '-q', '-m', 'base');

    t.git('checkout', '-q', '-b', 'c3');
    t.write(
      'supabase/migrations/0002_leads_write.sql',
      '-- 0002 — the leads write API (C3).\n\nselect 1;\n',
    );
    t.git('add', '-A');
    t.git('commit', '-q', '-m', 'C3');

    t.git('checkout', '-q', 'main');
    t.write('supabase/migrations/0003_uploads.sql', '-- 0003 — uploads (U3).\n\nselect 1;\n');
    t.write(LEDGER_PATH, U3_MERGED);
    t.git('add', '-A');
    t.git('commit', '-q', '-m', 'U3');

    t.git('checkout', '-q', 'c3');
    t.git('merge', '-q', '--no-edit', 'main');
  }, 60_000);

  afterAll(() => t?.cleanup());

  it('takes the reserved number once the branch has re-planned the rows', () => {
    // On the branch, C3 takes 0004 and R1 moves up to 0005.
    t.write(
      LEDGER_PATH,
      U3_MERGED.replace(C3_ROW, '| 0004 | C3 | the leads write API | 1 |').replace(
        '| 0004 | R1 |',
        '| 0005 | R1 |',
      ),
    );
    try {
      const result = t.run(
        SCRIPT,
        'supabase/migrations/0002_leads_write.sql',
        '--base',
        'main',
        '--dry-run',
      );
      expect(result.code, result.out).toBe(0);
      expect(result.out).toContain(
        'would rename supabase/migrations/0002_leads_write.sql → supabase/migrations/0004_leads_write.sql',
      );
      expect(result.out).not.toContain('skipped');
    } finally {
      t.git('checkout', '--', LEDGER_PATH);
    }
  });

  it('passes over the number reserved for another slice, and lists the ledger row to move', () => {
    const result = t.run(SCRIPT, 'supabase/migrations/0002_leads_write.sql', '--base', 'main');
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain(
      '0002_leads_write.sql → 0005_leads_write.sql (the highest on main is 0003)\n' +
        `    skipped 0004: reserved for R1 in ${LEDGER_PATH}\n`,
    );
    expect(t.read('supabase/migrations/0005_leads_write.sql')).toBe(
      '-- 0005 — the leads write API (C3).\n\nselect 1;\n',
    );
    // The ledger is the program's, written on the base: left as it is, its C3 row listed.
    expect(t.read(LEDGER_PATH)).toBe(U3_MERGED);
    expect(result.out).not.toContain(`update ${LEDGER_PATH}`);
    const row = U3_MERGED.split('\n').indexOf(C3_ROW) + 1;
    expect(result.out).toContain(
      `      ${LEDGER_PATH}:${row}  the reservation ledger: rows move by hand\n`,
    );
    expect(t.run(CHECK, 'main').code).toBe(0);
  });
});
