import { describe, expect, it } from 'vitest';
import { accentPreview, accentWords, clampAccent } from '@/lib/admin/accentWords';
import { accentTokens, splitAccent } from '@/lib/text/accent';
import { AccentSchema } from '@schemas/media';

// The admin's accent field counts the words of its sibling heading; the public renderer
// marks the same words. Both count through accentTokens, and these tests hold them equal —
// a tokeniser that drifted would highlight one thing in the form and another on the page.

describe('accentWords counts exactly what the public side counts', () => {
  const samples = [
    'Ideas that leave the brain and land in the world',
    'أفكار تغادر العقل وتصل إلى العالم',
    '  leading and trailing  ',
    'one',
    '',
    'tabs\tand\nnewlines  between',
    'ندير ٠١٢٣٤ و ۵۶۷۸۹ معًا',
  ];

  for (const text of samples) {
    it(`"${text.slice(0, 24)}" splits into the same words as splitAccent marks`, () => {
      const words = accentWords(text);
      // splitAccent with a from-0 range marks every word: the words it saw are ours.
      const marked = splitAccent(text, { from: 0 });
      const fromRuns = marked
        .filter((run) => run.accent)
        .map((run) => run.text)
        .join('')
        .split(/\s+/)
        .filter((w) => w !== '');
      expect(words).toEqual(fromRuns);
      expect(accentTokens(text).filter((t) => !/^\s+$/.test(t))).toEqual(words);
    });
  }

  it('keeps Arabic digits as words, untouched (P-12)', () => {
    expect(accentWords('ندير ٠١٢٣٤ و ۵۶۷۸۹ معًا')).toEqual(['ندير', '٠١٢٣٤', 'و', '۵۶۷۸۹', 'معًا']);
  });

  it('a word with its footnote mark is one word', () => {
    expect(accentWords('work that performs*')).toEqual(['work', 'that', 'performs*']);
  });
});

describe('clampAccent', () => {
  it('holds a range inside the words that are left', () => {
    expect(clampAccent({ from: 1, to: 3 }, 5)).toEqual({ from: 1, to: 3 });
    // The heading shrank to three words: `to` follows it.
    expect(clampAccent({ from: 1, to: 9 }, 3)).toEqual({ from: 1, to: 3 });
    // `from` past the end lands on the last word, which is then the whole highlight.
    expect(clampAccent({ from: 7, to: 9 }, 3)).toEqual({ from: 2, to: 3 });
    // A `to` no longer after `from` would be an empty highlight: it becomes "to the end".
    expect(clampAccent({ from: 2, to: 2 }, 3)).toEqual({ from: 2 });
  });

  it('"to the end" stays open', () => {
    expect(clampAccent({ from: 2 }, 6)).toEqual({ from: 2 });
    expect(clampAccent({ from: 2, to: undefined }, 6)).toEqual({ from: 2 });
  });

  it('no words, no range, no highlight', () => {
    expect(clampAccent({ from: 0, to: 2 }, 0)).toBeUndefined();
    expect(clampAccent(undefined, 5)).toBeUndefined();
    expect(clampAccent(null, 5)).toBeUndefined();
  });

  it('never offers a range the schema refuses', () => {
    for (const words of [1, 3, 12, 40, 80]) {
      for (const range of [
        { from: 0, to: 1 },
        { from: 5, to: 40 },
        { from: 60, to: 90 },
        { from: 30 },
        { from: -4, to: 2 },
        { from: 2.6, to: 7.9 },
      ]) {
        const held = clampAccent(range, words);
        if (!held) continue;
        const parsed = AccentSchema.safeParse({ en: held });
        expect(parsed.success, `${JSON.stringify({ range, words, held })}`).toBe(true);
        expect(held.from).toBeLessThan(words);
      }
    }
  });
});

describe('accentPreview', () => {
  it('shows which words carry the colour', () => {
    expect(accentPreview('Ideas that leave the brain', { from: 2, to: 4 })).toEqual({
      before: 'Ideas that',
      accented: 'leave the',
      after: 'brain',
    });
  });

  it('to the end, and none at all', () => {
    expect(accentPreview('one two three', { from: 1 })).toEqual({
      before: 'one',
      accented: 'two three',
      after: '',
    });
    expect(accentPreview('one two three', undefined)).toEqual({
      before: 'one two three',
      accented: '',
      after: '',
    });
  });
});
