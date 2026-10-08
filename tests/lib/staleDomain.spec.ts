import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';

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

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name).replace(/\\/g, '/');
    if (entry.isDirectory()) return walk(path);
    return entry.isFile() && !BINARY.has(extname(entry.name).toLowerCase()) ? [path] : [];
  });
}

const scanned = [...ROOTS.flatMap(walk), ...FILES];

describe('the one-i domain', () => {
  it('scans what it says it scans', () => {
    for (const path of [...ROOTS, ...FILES]) expect(existsSync(path), path).toBe(true);
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
    const allowed = (path: string, line: string) =>
      ALLOWED.some((a) => a.path === path && a.line.test(line));
    const hits = scanned.flatMap((path) =>
      readFileSync(path, 'utf8')
        .split(/\r?\n/)
        .flatMap((line, i) =>
          STALE.test(line) && !allowed(path, line) ? [`${path}:${i + 1}: ${line.trim()}`] : [],
        ),
    );
    expect(hits).toEqual([]);
  });

  it('keeps no allowance past its reason', () => {
    for (const { path, line } of ALLOWED) {
      const used =
        existsSync(path) &&
        readFileSync(path, 'utf8')
          .split(/\r?\n/)
          .some((text) => line.test(text));
      expect(used, `${path} no longer has the line ${line} allows: delete the allowance`).toBe(
        true,
      );
    }
  });
});
