import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as R from '../../scripts/renumber-migration.mjs';

// scripts/renumber-migration.mjs moves a branch's new migration above the base branch's
// highest when another branch merged the same number first (check-migrations rule 4). The
// rename is the easy half; these pin the other half too: a file on the base is never
// touched, a branch's several new migrations keep their order, and a bare number is
// rewritten only where this branch wrote it, never on a line about the base's own one.

const { addedLines, headerLength, parseArgs, planRenumber, rewriteReferences } = R;

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

  it('refuses to move a file below an earlier new migration that has not moved yet', () => {
    // 0040_a sorts first, so 0041_b's slot (0040) is still taken by it.
    const baseFiles = ['0038_x.sql'];
    const headFiles = [...baseFiles, '0040_a.sql', '0041_b.sql'];
    expect(() => planRenumber({ name: '0041_b.sql', baseFiles, headFiles })).toThrow(
      /0040_a\.sql is new on this branch too and must stay before 0041_b\.sql/,
    );
    expect(planRenumber({ name: '0040_a.sql', baseFiles, headFiles }).newName).toBe('0039_a.sql');
  });
});

describe('addedLines', () => {
  it('reads the added side of every -U0 hunk', () => {
    const diff = [
      'diff --git a/docs/x.md b/docs/x.md',
      '@@ -3,0 +4,2 @@ ## Reserved',
      '+one',
      '+two',
      '@@ -9 +11 @@',
      '-old',
      '+new',
      '@@ -20,3 +21,0 @@',
    ].join('\n');
    expect([...addedLines(diff)]).toEqual([4, 5, 11]);
    expect(addedLines('').size).toBe(0);
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
    });
  });

  it('rewrites the bare number only on the given lines', () => {
    const text = '- 0038 — the base’s own\n- 0038 — ours (0038_leads.sql)';
    expect(rewriteReferences(text, { ...refs, lines: new Set([2]) }).text).toBe(
      '- 0038 — the base’s own\n- 0039 — ours (0039_leads.sql)',
    );
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

// ── End to end, in a throwaway repository ─────────────────────────────────────────
// main adds 0002_other while a branch adds 0002_feature and 0003_more; the branch merges
// main and moves both up, the later one first. The git config of the machine running the
// tests is kept out, so no hook, signing rule or line-ending setting can change the outcome.

const SCRIPT = resolve('scripts/renumber-migration.mjs');
const CHECK = resolve('scripts/check-migrations.mjs');
let repo = '';
let env: NodeJS.ProcessEnv = process.env;

const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' });
const write = (path: string, text: string) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
};
const read = (path: string) => readFileSync(join(repo, path), 'utf8');
const run = (script: string, ...args: string[]) => {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], {
      cwd: repo,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out: stdout };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { code: e.status, out: `${e.stdout}${e.stderr}` };
  }
};

const LEDGER = '# Ledger\n\n## Merged\n\n- 0001 — init\n\n## Reserved\n\n- none yet\n';
const FEATURE =
  '-- ──────\n-- 0002 — the feature. Depends on 0001.\n--\n\n' +
  "create table feature ();\ncomment on table feature is 'added by 0002';\n";
const MORE = '-- 0003 — more. Depends on 0002_feature (0002).\n\nselect 1;\n';

// Each step spawns git and node several times: slow on a busy runner, never wrong.
describe('renumber-migration, end to end', { timeout: 30_000 }, () => {
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'renumber-'));
    writeFileSync(`${repo}.gitconfig`, '');
    env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: `${repo}.gitconfig`,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.test',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.test',
    };
    git('init', '-q', '-b', 'main');
    write('supabase/migrations/0001_init.sql', '-- 0001 — init\n\ncreate table t ();\n');
    write('supabase/tests/init.test.sql', '-- 0001 and 0002 belong to main\nselect 1;\n');
    write('docs/ledger.md', LEDGER);
    write('CLAUDE.md', '# Standard\n\nMigrations are forward-only.\n');
    write('src/feature.ts', '// 0002 belongs to main\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');

    git('checkout', '-q', '-b', 'work');
    write('supabase/migrations/0002_feature.sql', FEATURE);
    write('supabase/migrations/0003_more.sql', MORE);
    write(
      'supabase/tests/feature.test.sql',
      '-- pgTAP for 0002_feature.sql (0002) and 0003_more.sql\nselect 1;\n',
    );
    write(
      'docs/ledger.md',
      LEDGER.replace('- none yet', '- 0002 — feature (0002_feature.sql), 0003 — more'),
    );
    write('docs/as-built/feature.md', '# Feature\n\nShips 0002 and 0003.\n');
    write('CLAUDE.md', `${read('CLAUDE.md')}- 0002_feature adds the feature table.\n`);
    write('src/feature.ts', `${read('src/feature.ts')}// reads the 0002 table\n`);
    git('add', '-A');
    git('commit', '-q', '-m', 'feature');

    git('checkout', '-q', 'main');
    write('supabase/migrations/0002_other.sql', '-- 0002 — other\n\nselect 1;\n');
    write('docs/ledger.md', LEDGER.replace('- 0001 — init\n', '- 0001 — init\n- 0002 — other\n'));
    git('add', '-A');
    git('commit', '-q', '-m', 'other');

    git('checkout', '-q', 'work');
    git('merge', '-q', '--no-edit', 'main');
  }, 60_000);

  afterAll(() => {
    if (!repo) return;
    rmSync(repo, { recursive: true, force: true });
    rmSync(`${repo}.gitconfig`, { force: true });
  });

  it('check-migrations fails on the clash and points at this script', () => {
    const result = run(CHECK, 'main');
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/number 0002 already used/);
    expect(result.out).toContain('node scripts/renumber-migration.mjs <file> --base main');
  });

  it('refuses a migration that is on the base, and a move out of order', () => {
    const onBase = run(SCRIPT, 'supabase/migrations/0002_other.sql', '--base', 'main');
    expect(onBase.code).toBe(1);
    expect(onBase.out).toMatch(
      /0002_other\.sql exists on main, and migrations there are immutable/,
    );
    const early = run(SCRIPT, 'supabase/migrations/0002_feature.sql', '--base', 'main');
    expect(early.code).toBe(1);
    expect(early.out).toMatch(/renumber 0003_more\.sql first/);
  });

  it('a dry run lists the changes and makes none', () => {
    const before = git('status', '--porcelain');
    const result = run(SCRIPT, 'supabase/migrations/0003_more.sql', '--base', 'main', '--dry-run');
    expect(result.code).toBe(0);
    expect(result.out).toContain(
      'would rename supabase/migrations/0003_more.sql → supabase/migrations/0004_more.sql',
    );
    expect(result.out).toContain('would update docs/ledger.md');
    expect(git('status', '--porcelain')).toBe(before);
    expect(existsSync(join(repo, 'supabase/migrations/0003_more.sql'))).toBe(true);
  });

  it('renames with git mv, rewrites the references, and lists every file it changed', () => {
    const more = run(SCRIPT, 'supabase/migrations/0003_more.sql', '--base', 'main');
    expect(more.code, more.out).toBe(0);
    const result = run(SCRIPT, 'supabase/migrations/0002_feature.sql', '--base', 'main');
    expect(result.code, result.out).toBe(0);

    expect(git('diff', '--cached', '--name-status')).toMatch(
      /^R\d*\tsupabase\/migrations\/0002_feature\.sql\tsupabase\/migrations\/0003_feature\.sql$/m,
    );
    // Its header follows; the SQL under it is a value, so it is reported, not rewritten.
    expect(read('supabase/migrations/0003_feature.sql')).toBe(
      FEATURE.replace('-- 0002 — the feature', '-- 0003 — the feature'),
    );
    // A sibling's header names it too.
    expect(read('supabase/migrations/0004_more.sql')).toBe(
      '-- 0004 — more. Depends on 0003_feature (0003).\n\nselect 1;\n',
    );
    expect(read('supabase/tests/feature.test.sql')).toBe(
      '-- pgTAP for 0003_feature.sql (0003) and 0004_more.sql\nselect 1;\n',
    );
    expect(read('supabase/tests/init.test.sql')).toBe(
      '-- 0001 and 0002 belong to main\nselect 1;\n',
    );
    // The ledger line about main's own 0002 is the base's: untouched.
    expect(read('docs/ledger.md')).toBe(
      LEDGER.replace('- 0001 — init\n', '- 0001 — init\n- 0002 — other\n').replace(
        '- none yet',
        '- 0003 — feature (0003_feature.sql), 0004 — more',
      ),
    );
    expect(read('docs/as-built/feature.md')).toBe('# Feature\n\nShips 0003 and 0004.\n');
    expect(read('CLAUDE.md')).toContain('- 0003_feature adds the feature table.');

    for (const file of [
      'supabase/migrations/0003_feature.sql (header',
      'supabase/migrations/0004_more.sql (header',
      'supabase/tests/feature.test.sql',
      'docs/ledger.md',
      'docs/as-built/feature.md',
      'CLAUDE.md',
    ]) {
      expect(result.out).toContain(`update ${file}`);
    }
    expect(result.out).not.toContain('update supabase/tests/init.test.sql');
    // Left alone and listed for a reader: the SQL, and the comment this branch wrote in
    // src/ (not main's line above it).
    expect(result.out).toMatch(
      /not rewritten, still naming 0002 or 0002_feature \(check by hand\):\n\s+supabase\/migrations\/0003_feature\.sql:6\n\s+src\/feature\.ts:2\n/,
    );
    expect(read('src/feature.ts')).toBe('// 0002 belongs to main\n// reads the 0002 table\n');

    expect(run(CHECK, 'main').code).toBe(0);
  });

  it('is a no-op once the file is in place', () => {
    const result = run(SCRIPT, 'supabase/migrations/0003_feature.sql', '--base', 'main');
    expect(result.code).toBe(0);
    expect(result.out).toContain('nothing to do');
  });
});
