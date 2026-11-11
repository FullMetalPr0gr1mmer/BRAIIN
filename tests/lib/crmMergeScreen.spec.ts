import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import MergeDuplicatesDialog, {
  afterMerge,
  mergeFocusTarget,
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

// (C12 review, C12-COR-2) Every press in the dialog removes or disables the button pressed,
// so focus is placed after each one, never left on the page's body (WCAG 2.4.3; axe cannot
// see it). merge.e2e.ts asserts it on the real dialog.
describe('focus after a press', () => {
  const el = (name: string) => ({ name }) as unknown as HTMLElement;
  const rootOf = (found: Record<string, HTMLElement>) => ({
    querySelector: <E extends Element>(selector: string) => (found[selector] ?? null) as E | null,
  });
  const KEY = 'a:b';
  const cancel = `[data-merge-pair="${KEY}"] [data-merge-cancel]`;
  const own = `[data-merge-pair="${KEY}"] [data-merge-start]`;
  const at = (i: number) => `[data-merge-index="${i}"] [data-merge-start]`;

  it('opening the confirm group puts focus on its Cancel', () => {
    expect(
      mergeFocusTarget(rootOf({ [cancel]: el('cancel') }), { to: 'confirm', key: KEY }),
    ).toEqual(el('cancel'));
  });

  it('Cancel or a refusal puts it back on the pair’s Merge into older', () => {
    const root = rootOf({ [own]: el('own'), [at(0)]: el('first') });
    expect(mergeFocusTarget(root, { to: 'pair', key: KEY, index: 3 })).toEqual(el('own'));
  });

  it('a pair that left hands focus to the next pair, else the one before, else the first, else the empty state, else Done', () => {
    const next = { to: 'next', index: 2 } as const;
    expect(mergeFocusTarget(rootOf({ [at(2)]: el('two'), [at(1)]: el('one') }), next)).toEqual(
      el('two'),
    );
    expect(mergeFocusTarget(rootOf({ [at(1)]: el('one') }), next)).toEqual(el('one'));
    expect(mergeFocusTarget(rootOf({ '[data-merge-start]': el('any') }), next)).toEqual(el('any'));
    expect(mergeFocusTarget(rootOf({ '[data-merge-empty]': el('empty') }), next)).toEqual(
      el('empty'),
    );
    expect(mergeFocusTarget(rootOf({ '[data-merge-done]': el('done') }), next)).toEqual(el('done'));
    // A pair gone from under a refusal goes the same way.
    expect(
      mergeFocusTarget(rootOf({ [at(2)]: el('two') }), { to: 'pair', key: KEY, index: 2 }),
    ).toEqual(el('two'));
  });

  it('every press says where focus goes, and the dialog places it after the draw', () => {
    const source = read('src/components/admin/screens/contacts/MergeDuplicatesDialog.tsx');
    expect(source).toContain('mergeFocusTarget(document, next)?.focus();');
    // Merge into older → the confirm group; Cancel → back to the pair.
    expect(source).toMatch(
      /focusNext\.current = \{ to: 'confirm', key \};\s*setConfirming\(\{ key, keepId: older\.keep\.id \}\);/,
    );
    expect(source).toMatch(
      /focusNext\.current = \{ to: 'pair', key, index \};\s*setConfirming\(null\);/,
    );
    // A dismissed or merged pair → the next one.
    expect(source.match(/focusNext\.current = \{ to: 'next', index \};/g)?.length).toBe(3);
    // The targets the helper names are on the markup.
    for (const attr of [
      'data-merge-pair={key}',
      'data-merge-index={index}',
      'data-merge-start=""',
      'data-merge-cancel=""',
      'data-merge-empty=""',
      'data-merge-done=""',
    ]) {
      expect(source, attr).toContain(attr);
    }
    // The empty state can take focus; the confirm group is described by its preview.
    expect(source).toMatch(/className="ct-merge__name" tabIndex=\{-1\} data-merge-empty=""/);
    expect(source).toMatch(/aria-describedby=\{`\$\{previewId\}-\$\{index\}`\}/);
  });
});

// (C12 review, C12-COR-6) A reopened dialog never shows the last opening's pairs (their old
// versions, live buttons) while it reads, and a 404 takes the dead pair away and reads again.
describe('reopening, and a pair that is gone', () => {
  const source = read('src/components/admin/screens/contacts/MergeDuplicatesDialog.tsx');

  it('each opening drops the last opening’s pairs and words', () => {
    expect(source).toMatch(
      /useEffect\(\(\) => \{\s*if \(!open\) return;\s*setPairs\(null\);\s*setError\(''\);/,
    );
  });

  it('a 404 from a merge or a dismissal removes the pair and reads the list again', () => {
    expect(source.match(/status === 404\) \{\s*gone\(key, index\);/g)?.length).toBe(2);
    expect(source).toMatch(
      /function gone\(key: string, index: number\) \{[\s\S]*?setPairs\(\(list\) => \(list \?\? \[\]\)\.filter\(\(p\) => pairKey\(p\) !== key\)\);[\s\S]*?setReads\(\(r\) => r \+ 1\);/,
    );
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
