import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { UNREADABLE_SELECTOR, badInputErrors, unreadableIn } from '@/lib/admin/fieldErrors';

// Admin v2 R14d: release mode's automatic save never sends a form whose number or date box holds
// text the browser could not read. Such a box reports '' to script; the person's Save already
// refused it (review M2: it would clear the stored value), but the save on leaving a field and
// on a tab switch (P-5, draft mode only) went around that check and sent '' as "no value". Found
// converting fields.e2e's M2 test to release mode. Releases off nothing saves by itself.

type Box = {
  id: string;
  type: string;
  dataset: { label?: string };
  validity: { badInput: boolean };
};

const form = (boxes: Box[]) =>
  ({
    querySelectorAll: (selector: string) => {
      expect(selector).toBe(UNREADABLE_SELECTOR);
      return boxes;
    },
  }) as unknown as ParentNode;

describe('unreadableIn (fieldErrors.ts)', () => {
  it('names the number and date boxes the browser could not read, with their labels', () => {
    const found = unreadableIn(
      form([
        {
          id: 'f-sortOrder',
          type: 'number',
          dataset: { label: 'Sort order' },
          validity: { badInput: true },
        },
        { id: 'f-year', type: 'number', dataset: { label: 'Year' }, validity: { badInput: false } },
        { id: 'f-when', type: 'datetime-local', dataset: {}, validity: { badInput: true } },
      ]),
    );
    expect(found).toEqual([
      { id: 'f-sortOrder', type: 'number', label: 'Sort order' },
      { id: 'f-when', type: 'datetime-local', label: '' },
    ]);
    expect(badInputErrors(found).summary[0]).toEqual({
      id: 'f-sortOrder',
      message: 'Sort order: Enter a number, or clear the box.',
    });
  });

  it('reads the three kinds of box, and nothing without a form', () => {
    expect(UNREADABLE_SELECTOR).toBe(
      'input[type="number"], input[type="datetime-local"], input[type="date"]',
    );
    expect(unreadableIn(null)).toEqual([]);
    expect(unreadableIn(form([]))).toEqual([]);
  });
});

describe('EditorForm: every automatic save asks first', () => {
  const src = readFileSync('src/components/admin/fields/EditorForm.tsx', 'utf8');

  it('autoSave saves only when no box is unreadable', () => {
    expect(src).toMatch(
      /const autoSave = \(\) => \{\s*if \(unreadableIn\(formRef\.current\)\.length > 0\) return;\s*save\.flush\?\.\(\);\s*\};/,
    );
  });

  it('the blur, the tab switch and History save through it, and nothing flushes around it', () => {
    expect(src).toContain('onBlur={draftMode ? () => window.setTimeout(autoSave, 0) : undefined}');
    expect(src).toMatch(/const choose = \(id: string\) => \{[\s\S]*?autoSave\(\);\s*\};/);
    expect(src).toMatch(/onClick=\{\(\) => \{\s*\/\/[^\n]*\n\s*autoSave\(\);\s*setHistoryMounted/);
    // The one flush left is autoSave's own.
    expect(src.match(/save\.flush\?\.\(\)/g)).toHaveLength(1);
  });

  it('the person’s Save reads the same boxes', () => {
    expect(src).toMatch(
      /function submit\(\) \{\s*const unreadable = unreadableIn\(formRef\.current\);/,
    );
  });
});
