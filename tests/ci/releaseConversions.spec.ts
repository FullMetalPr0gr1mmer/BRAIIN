import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/*
 * The admin e2e specs in both release modes (Admin v2 R14d, R14b's B2; R14a's conversion
 * rules). e2e runs only in CI, so this holds the shape of the conversion statically:
 *   - the nine specs B2 named run in both modes: no file-level skip, no RELEASES_OFF_ONLY;
 *   - RELEASES_OFF_ONLY is left only where R14b named true releases-off behaviour (the
 *     releases-off describes of backups, dashboard's arranging and releases-ui);
 *   - every converted spec takes its release steps from tests/admin/releaseSteps.ts;
 *   - no admin spec names a dialog by its CSS class (the savebar island adds a closed one to
 *     every page, RM-01), and no test title carries a per-load random (a title must be the same
 *     when Playwright lists the tests and when a worker runs them);
 *   - general's second-tab conflict changes a value live does not hold, and reads the banner's
 *     words from the form's own constant (the rehearsal's failure).
 */

const ADMIN = 'tests/admin';
const read = (file: string) => readFileSync(`${ADMIN}/${file}`, 'utf8');
const specs = readdirSync(ADMIN).filter((f) => f.endsWith('.e2e.ts'));

/** The specs R14b's B2 named, converted by R14d. */
const B2 = [
  'blog',
  'collections',
  'faq',
  'fields',
  'pages',
  'projects',
  'reorder',
  'seo',
  'services',
].map((name) => `${name}.e2e.ts`);

describe('B2: the nine specs run in both release modes', () => {
  it('none of them skips in release mode, at file level or anywhere', () => {
    for (const file of B2) {
      const src = read(file);
      expect(src, file).not.toContain('RELEASES_OFF_ONLY');
      expect(src, file).not.toMatch(/test\.skip\(\s*releasesOn\(\)/);
    }
  });

  it('each takes its release steps from releaseSteps.ts', () => {
    for (const file of B2) {
      expect(read(file), file).toMatch(/from '\.\/releaseSteps';/);
    }
  });

  it('RELEASES_OFF_ONLY is left only on the releases-off describes R14b named', () => {
    const users = specs.filter((file) => read(file).includes('RELEASES_OFF_ONLY')).sort();
    expect(users).toEqual(['backups.e2e.ts', 'dashboard.e2e.ts', 'releases-ui.e2e.ts']);
    for (const file of users) {
      // Inside a describe (indented), never the whole file.
      expect(read(file), file).not.toMatch(/^test\.skip\(releasesOn\(\), RELEASES_OFF_ONLY\)/m);
    }
  });
});

describe('every admin spec', () => {
  it('names no dialog by its CSS class', () => {
    for (const file of specs) {
      expect(read(file), file).not.toMatch(/locator\(\s*['"`][^'"`]*dialog\.admin-dialog/);
    }
  });

  it('carries no per-load random in a test title', () => {
    // A title built from a value made at load time (randomBytes, Date.now, Math.random).
    const titleWith = (name: string) =>
      new RegExp(String.raw`\btest(?:\.describe)?\(\s*` + '`[^`]*\\$\\{' + name + String.raw`\b`);
    // The pattern finds what it is for (never a check that silently matches nothing).
    expect('test(`saves ${RUN} twice`, async () => {});').toMatch(titleWith('RUN'));
    expect("test('saves twice', async () => { use(`${RUN}`); });").not.toMatch(titleWith('RUN'));
    let checked = 0;
    for (const file of specs) {
      const src = read(file);
      const random = [
        ...src.matchAll(
          /const (\w+) = [^;\n]*(?:randomBytes|Date\.now\(\)|Math\.random\(\))[^;\n]*;/g,
        ),
      ].map((m) => m[1]!);
      for (const name of random) {
        checked += 1;
        expect(src, `${file}: ${name} in a title`).not.toMatch(titleWith(name));
      }
    }
    // The nine specs' markers (MARK, RUN) are among the values checked.
    expect(checked).toBeGreaterThanOrEqual(B2.length - 2);
  });
});

describe('general: a second tab’s save is a 409 in both modes (the rehearsal’s failure)', () => {
  const src = read('general.e2e.ts');
  const test = src.slice(src.indexOf('a second tab’s save is a 409'));

  it('the other tab changes a value the identity does not hold, and says so with releases on', () => {
    // The seed's founded year is what a no-op save would send: with releases on it stages
    // nothing, and the first tab then meets nothing.
    expect(test).toMatch(/const founded = row\['founded_year'\] === 2018 \? 2017 : 2018;/);
    expect(test).toMatch(/withDraft\(row, \{ foundedYear: founded \}\)/);
    expect(test).toMatch(/if \(releasesOn\(\)\) expect\(theirs\['draft'\]/);
    // And the restore puts the year back (with releases off the change went live).
    expect(src).toMatch(/foundedYear: row\['founded_year'\] \?\? null,/);
  });

  it('reads the banner from the form’s own words', () => {
    expect(src).toContain("import { CONFLICT_WORDS } from '@/lib/admin/entitySave';");
    expect(test).toMatch(/getByRole\('alert'\)\.filter\(\{ hasText: CONFLICT_WORDS \}\)/);
    const form = readFileSync('src/components/admin/fields/EditorForm.tsx', 'utf8');
    expect(form).toContain('<span>{CONFLICT_WORDS}</span>');
  });
});
