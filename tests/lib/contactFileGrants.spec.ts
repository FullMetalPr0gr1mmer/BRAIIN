import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// Contact files (Admin v2 C16) have a short, named list of Worker callers, as the contacts'
// ciphertext does (tests/lib/contactGrants.spec.ts): the private bucket is the service role's
// alone, a file's object path is never granted to staff (0140's column grant), and a file
// leaves the bucket through one route, behind crm.files, a live recheck, a limit and an audit
// row written first. A new caller fails here until it is named, with the reason.

const SRC = join(process.cwd(), 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|astro)$/.test(name) ? [path] : [];
  });
}

const files = sourceFiles(SRC).map((path) => ({
  path: relative(process.cwd(), path).replace(/\\/g, '/'),
  code: readFileSync(path, 'utf8'),
}));

const named = (pattern: RegExp) =>
  files
    .filter((f) => pattern.test(f.code))
    .map((f) => f.path)
    .sort();

const callers = (fn: string) => named(new RegExp(`rpc\\(\\s*['"]${fn}['"]`));

describe('contact files: the bucket and the paths', () => {
  it('only src/lib/crm/files.ts names the bucket and reads an object path', () => {
    expect(named(/['"]crm-files['"]/)).toEqual(['src/lib/crm/files.ts']);
    expect(named(/\bobject_path\b/)).toEqual([
      'src/lib/crm/files.ts',
      // The upload hands the door the path it just stored the object under.
      'src/pages/api/admin/crm/contacts/[id]/files.ts',
    ]);
  });

  it('a file leaves the bucket through the download route alone', () => {
    expect(named(/\bdownloadFileObject\(/)).toEqual([
      'src/lib/crm/files.ts',
      'src/pages/api/admin/crm/contacts/[id]/files/[fileId].ts',
    ]);
  });

  it('objects are stored by the upload and removed by named callers only', () => {
    expect(named(/\buploadFileObject\(/)).toEqual([
      'src/lib/crm/files.ts',
      'src/pages/api/admin/crm/contacts/[id]/files.ts',
    ]);
    expect(named(/\bremoveFileObjects\(/)).toEqual([
      // The sweep: objects no row names.
      'src/lib/crm/fileOrphans.ts',
      // removePersonFiles, for the person erasure.
      'src/lib/crm/files.ts',
      // The upload's compensation for a refused row.
      'src/pages/api/admin/crm/contacts/[id]/files.ts',
      // The removal: the object first.
      'src/pages/api/admin/crm/contacts/[id]/files/[fileId].ts',
    ]);
    expect(named(/\bremovePersonFiles\(/)).toEqual([
      'src/lib/crm/files.ts',
      'src/pages/api/admin/crm/contacts/[id]/erase.ts',
    ]);
  });

  it.each([
    ['crm_file_add', 'src/pages/api/admin/crm/contacts/[id]/files.ts'],
    ['crm_file_remove', 'src/pages/api/admin/crm/contacts/[id]/files/[fileId].ts'],
    ['crm_file_orphans', 'src/lib/crm/fileOrphans.ts'],
  ])('the door %s has one caller: %s', (fn, file) => {
    expect(callers(fn)).toEqual([file]);
  });

  it('every file route that reaches the bucket rechecks the profile live first', () => {
    for (const path of [
      'src/pages/api/admin/crm/contacts/[id]/files.ts',
      'src/pages/api/admin/crm/contacts/[id]/files/[fileId].ts',
    ]) {
      const code = files.find((f) => f.path === path)!.code;
      for (const method of code.split(/export const (?=GET|POST|DELETE)/).slice(1)) {
        if (!/serviceClient\(\)/.test(method)) continue;
        const live = method.indexOf('liveRecheck(auth)');
        expect(live, `${path} ${method.slice(0, 6)}`).toBeGreaterThan(0);
        expect(live).toBeLessThan(method.indexOf('serviceClient()'));
      }
    }
  });
});
