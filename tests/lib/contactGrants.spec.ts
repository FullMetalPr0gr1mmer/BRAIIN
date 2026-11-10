import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// The contacts' ciphertext, notes and service-role doors have a short, named list of Worker
// callers (Admin v2 C6), as the leads' do (tests/lib/leadGrants.spec.ts). Staff tokens read
// no channel value or index (C5's column grant) and no note at all (no policy), so those
// leave the database only through these files, each behind assertCap, a live recheck and,
// where a person sees a value, a fail-closed audit row. A new reader fails here until it is
// named, with the reason.

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

describe('contact ciphertext and notes', () => {
  it('only these files name a channel ciphertext or its index', () => {
    expect(named(/\bvalue_(enc|hmac)\b/)).toEqual([
      // The reveal: the one decrypting reader (live recheck, limiter, audit first).
      'src/lib/crm/contactReveal.ts',
      // sealChannels: encrypts and indexes what a person typed (never decrypts).
      'src/lib/crm/contacts.ts',
    ]);
  });

  it('only the notes routes touch the notes', () => {
    expect(named(/from\(\s*['"]crm_contact_notes['"]\s*\)/)).toEqual([
      'src/pages/api/admin/crm/contacts/[id]/notes.ts',
    ]);
  });

  it('the reveal is called by its route alone', () => {
    expect(named(/\brevealContact\(/)).toEqual([
      'src/lib/crm/contactReveal.ts',
      'src/pages/api/admin/crm/contacts/[id]/reveal.ts',
    ]);
  });
});

describe('the service role contact doors have named callers', () => {
  it.each([
    ['crm_create_contact', 'src/pages/api/admin/crm/contacts/index.ts'],
    ['crm_edit_contact_channels', 'src/pages/api/admin/crm/contacts/[id].ts'],
    ['crm_delete_contact_note', 'src/pages/api/admin/crm/contacts/[id]/notes/[noteId].ts'],
    ['crm_contact_link_lead', 'src/pages/api/admin/crm/contacts/[id]/links.ts'],
    // ingestContactLead, called by POST /api/admin/crm/contacts/[id]/leads.
    ['crm_contact_new_lead', 'src/lib/data/leads.ts'],
    ['crm_erase_preview', 'src/pages/api/admin/crm/contacts/[id]/erase-preview.ts'],
    ['crm_erase_person', 'src/pages/api/admin/crm/contacts/[id]/erase.ts'],
  ])('%s: %s only', (fn, file) => {
    expect(callers(fn)).toEqual([file]);
  });

  it('every contacts route that uses the service role rechecks the profile live first', () => {
    const routes = files.filter(
      (f) =>
        f.path.startsWith('src/pages/api/admin/crm/contacts/') &&
        /\bserviceClient\(\)|\bingestContactLead\(|\brevealContact\(/.test(f.code),
    );
    expect(routes.length).toBeGreaterThanOrEqual(8);
    for (const route of routes) {
      const live = /\bliveRecheck\(auth\)|\brevealContact\(/.test(route.code);
      expect(live, `${route.path} uses the service role without a live recheck`).toBe(true);
    }
  });
});
