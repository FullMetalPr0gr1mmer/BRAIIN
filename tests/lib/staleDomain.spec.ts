import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The one-i domain — braiinstation.com — was never the studio's: theirs is
// braiinstatiion.com, two i's, registered at GoDaddy with Microsoft 365 mail. Nobody has
// registered the one-i name, so mail to it bounced (the privacy notice's mailbox did, until
// design-port J-17), and whoever registers it would receive whatever is still sent there.
// The live verification of 2026-10-03 found it in the legal copy, the Astro config, the
// seeds and the test stub; this gate keeps it out of everything that ships or seeds.
//
// Scanned: the site (src, public's text files), the shared packages, the scripts, the seed
// data and the generated seeds, the CI workflows, and the root config and docs a newcomer
// reads first.
//
// NOT scanned, on purpose:
//   - supabase/migrations/ — applied migrations are history and never edited; 0019's
//     comment that the domain "stays" is a statement of its day, read by nothing;
//   - docs/ — the record of what happened, the EXC-004 correction included, has to be able
//     to name the domain it corrects;
//   - tests/ — fixtures where a host is the test's own input (request origins, the CSRF
//     cases) and the assertions that the domain is gone.
//
// Only the files git tracks are scanned: what ships, seeds or builds is what is committed
// (CI's checkout holds nothing else). Listing the directories on disk instead raced with
// whatever writes beside the files while the suite runs: an editor's atomic save writes
// `<file>.tmp.<pid>.<hash>` next to the file and renames it over the original, so the walk
// could list the temporary file and find it gone when it came to read it (ENOENT), which
// failed the gate in a full run now and then. A temporary file is never tracked.
//
// No allowances. There was one — ci.yml's build-test placeholder origin — until the CI
// restructure moved it to the two-i domain; .github/ is now held like everything else. A
// future allowance must still match its line (the last test), so none can outlive its
// reason.

const STALE = /braiinstation\.com/i;

const ALLOWED: readonly { path: string; line: RegExp }[] = [];

const ROOTS = [
  'src',
  'public',
  'packages',
  'scripts',
  'supabase/seed-data',
  'supabase/seeds',
  '.github',
];
const FILES = [
  'supabase/seed.sql',
  'astro.config.mjs',
  'wrangler.jsonc',
  'package.json',
  '.env.example',
  'README.md',
  'CONTRIBUTING.md',
];
/** Never text; public/media/showreel.mp4 alone is 12 MB. */
const BINARY = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.ico',
  '.pdf',
  '.woff',
  '.woff2',
  '.mp4',
  '.webm',
]);

const REPO = fileURLToPath(new URL('../..', import.meta.url));

/**
 * git in `cwd`, never pointed elsewhere by the caller's environment: git exports GIT_DIR,
 * GIT_WORK_TREE and GIT_INDEX_FILE to its hooks (and GIT_OBJECT_DIRECTORY, GIT_COMMON_DIR
 * and the rest can do the same), so a run started from one would otherwise list another
 * repository's index, or a commit's temporary one. Every GIT_* variable is dropped; `extra`
 * (a test's own config isolation) is added back after.
 */
function git(
  cwd: string,
  args: readonly string[],
  extra: Readonly<Record<string, string>> = {},
): string {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^GIT_/i.test(key)) delete env[key];
  }
  return execFileSync('git', args, {
    cwd,
    env: { ...env, ...extra },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * The text files git tracks under `roots` in `repo`, as repo-relative paths. A symlink is
 * not a file to read (the walk this replaces skipped it too), a submodule is another
 * repository (the repo has none), and a tracked file deleted from the working tree and not
 * yet staged is not there to ship.
 */
function trackedUnder(repo: string, roots: readonly string[]): string[] {
  const paths = new Set<string>();
  // -s: "<mode> <object> <stage>\t<path>"; -z: NUL-terminated, paths unquoted.
  for (const entry of git(repo, ['ls-files', '-s', '-z', '--', ...roots]).split('\0')) {
    if (!entry) continue;
    const mode = entry.slice(0, entry.indexOf(' '));
    const path = entry.slice(entry.indexOf('\t') + 1);
    if (mode === '120000' || mode === '160000') continue;
    if (BINARY.has(extname(path).toLowerCase())) continue;
    if (existsSync(join(repo, path))) paths.add(path); // a merge lists a path once per stage
  }
  return [...paths];
}

/** Every line of `paths` (read from `repo`) naming the one-i domain, minus the allowances. */
function staleLines(repo: string, paths: readonly string[]): string[] {
  const allowed = (path: string, line: string) =>
    ALLOWED.some((a) => a.path === path && a.line.test(line));
  return paths.flatMap((path) =>
    readFileSync(join(repo, path), 'utf8')
      .split(/\r?\n/)
      .flatMap((line, i) =>
        STALE.test(line) && !allowed(path, line) ? [`${path}:${i + 1}: ${line.trim()}`] : [],
      ),
  );
}

const scanned = [...trackedUnder(REPO, ROOTS), ...FILES];

describe('the one-i domain', { timeout: 30_000 }, () => {
  it('scans what it says it scans', () => {
    for (const path of [...ROOTS, ...FILES]) expect(existsSync(join(REPO, path)), path).toBe(true);
    // The named files are tracked too, so everything scanned is.
    const tracked = git(REPO, ['ls-files', '-z', '--', ...FILES])
      .split('\0')
      .filter(Boolean);
    expect(tracked.sort()).toEqual([...FILES].sort());
    for (const path of [
      'src/middleware.ts',
      'src/lib/legal/content.ts',
      'public/_headers',
      'packages/consent/recruitment.ts',
      'scripts/gen-seeds.mjs',
      'supabase/seed-data/00-tenant.json',
      'supabase/seeds/production.sql',
      '.github/workflows/ci.yml',
    ]) {
      expect(scanned, path).toContain(path);
    }
  });

  it('appears in no file that ships, seeds, builds or configures the site', () => {
    expect(staleLines(REPO, scanned)).toEqual([]);
  });

  it('keeps no allowance past its reason', () => {
    for (const { path, line } of ALLOWED) {
      const used =
        existsSync(join(REPO, path)) &&
        readFileSync(join(REPO, path), 'utf8')
          .split(/\r?\n/)
          .some((text) => line.test(text));
      expect(used, `${path} no longer has the line ${line} allows: delete the allowance`).toBe(
        true,
      );
    }
  });

  // The listing above is git's, so prove on a throwaway repository that the gate still
  // fires: a tracked file under a scanned root is caught, with its line, while an untracked
  // file (an editor's temporary one), a tracked file outside the roots and a binary file
  // are not read.
  it('catches the domain in a tracked file, and reads nothing git does not track', () => {
    const base = mkdtempSync(join(tmpdir(), 'stale-domain-'));
    try {
      const repo = join(base, 'repo');
      const config = join(base, 'gitconfig');
      writeFileSync(config, '');
      // The machine's git config stays out: no global ignore rule, hook or line-ending
      // setting can change what is tracked here.
      const isolated = { GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' };
      const put = (path: string, text: string) => {
        mkdirSync(dirname(join(repo, path)), { recursive: true });
        writeFileSync(join(repo, path), text);
      };
      put('src/lib/legal.ts', "export const MAILBOX = 'privacy@braiinstation.com';\n");
      put('src/lib/clean.ts', "export const MAILBOX = 'privacy@braiinstatiion.com';\n");
      put('src/lib/legal.ts.tmp.4242.9f1c2e', "export const MAILBOX = 'hi@braiinstation.com';\n");
      put('docs/history.md', 'The old mailbox was privacy@braiinstation.com.\n');
      put('public/logo.png', 'braiinstation.com');
      git(repo, ['init', '-q'], isolated);
      git(
        repo,
        ['add', '--', 'src/lib/legal.ts', 'src/lib/clean.ts', 'docs/history.md', 'public/logo.png'],
        isolated,
      );

      const files = trackedUnder(repo, ROOTS);
      expect(files.sort()).toEqual(['src/lib/clean.ts', 'src/lib/legal.ts']);
      expect(staleLines(repo, files)).toEqual([
        "src/lib/legal.ts:1: export const MAILBOX = 'privacy@braiinstation.com';",
      ]);

      // A caller whose environment points git at the throwaway repository (as a hook's
      // does) still gets this repository's listing.
      const own = trackedUnder(REPO, ['supabase/seeds']);
      const planted = {
        GIT_DIR: join(repo, '.git'),
        GIT_WORK_TREE: repo,
        GIT_INDEX_FILE: join(base, 'no-such-index'),
        GIT_OBJECT_DIRECTORY: join(repo, '.git', 'objects'),
        GIT_COMMON_DIR: join(repo, '.git'),
      };
      const saved = Object.fromEntries(Object.keys(planted).map((k) => [k, process.env[k]]));
      try {
        Object.assign(process.env, planted);
        expect(trackedUnder(REPO, ['supabase/seeds'])).toEqual(own);
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
      expect(own.length).toBeGreaterThan(0);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
