import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import MergeDuplicatesDialog, {
  afterMerge,
  pairKey,
} from '@/components/admin/screens/contacts/MergeDuplicatesDialog';
import type { DuplicatePair, DuplicateSide } from '@schemas/crmMerge';

// The Merge duplicates screen (Admin v2 C12, crm.md §11 screen 9): a lazy modal on the People
// list. Its first render carries no inline style and no contact detail; after a merge no pair
// naming either record is left on screen; the People page offers the button to crm.contacts
// holders only and the list loads the dialog through import() only.

const read = (path: string) => readFileSync(path, 'utf8');

const person = (id: string, name: string): DuplicateSide => ({
  id,
  display_name: name,
  title: null,
  company_name: 'Acme',
  stage: 'lead',
  created_at: '2026-01-01T00:00:00Z',
  last_activity_at: '2026-11-01T00:00:00Z',
  version: 1,
  leads: 1,
  emails: 1,
  phones: 1,
});
const pair = (a: string, b: string): DuplicatePair => ({
  reasons: ['phone'],
  a: person(a, `P ${a}`),
  b: person(b, `P ${b}`),
});

describe('the dialog', () => {
  it('first renders closed, with no inline style', () => {
    const html = renderToStaticMarkup(
      createElement(MergeDuplicatesDialog, { open: false, onClose: () => {}, onMerged: () => {} }),
    );
    expect(html).toContain('Merge duplicates');
    expect(html).not.toMatch(/\sstyle=/);
    expect(html).not.toMatch(/[–—]/);
  });

  it('after a merge, no pair naming either record stays', () => {
    const pairs = [pair('a', 'b'), pair('b', 'c'), pair('c', 'd'), pair('a', 'e')];
    expect(afterMerge(pairs, ['a', 'b']).map(pairKey)).toEqual(['c:d']);
  });

  it('never draws a contact detail: the pair type carries counts, not values', () => {
    const source = read('src/components/admin/screens/contacts/MergeDuplicatesDialog.tsx');
    expect(source).not.toMatch(/mailto:|tel:|wa\.me|value_enc|value_hmac/);
  });
});

describe('the People page', () => {
  it('offers Merge duplicates to the page that is allowed, hidden until the island is up', () => {
    const page = read('src/pages/admin/contacts/index.astro');
    expect(page).toMatch(
      /allowed && \(\s*<button slot="actions" type="button" data-contact-merge hidden>/,
    );
    expect(page).toContain('Merge duplicates');
  });

  it('the list loads the dialog through import() only, on that button', () => {
    const list = read('src/components/admin/screens/contacts/ContactsList.tsx');
    expect(list).toContain("import('./MergeDuplicatesDialog')");
    expect(list).toContain("usePageButton('[data-contact-merge]', true, mergeDuplicates.open)");
    expect(list).not.toMatch(/^import\s+(?!type\b)[^;]*MergeDuplicatesDialog/m);
  });
});
