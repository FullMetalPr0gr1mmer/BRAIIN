import { describe, it, expect } from 'vitest';
import { splitTrailingMark } from '@/lib/text/accent';
import { SLIDE_MS, slideInterval } from '@/lib/client/carousel';

// Pure helpers the home page (UI v2 PR7) added to shared modules.

describe('splitTrailingMark — the hero accent never takes the footnote asterisk', () => {
  it('splits a trailing * off the accented word', () => {
    expect(splitTrailingMark('performs*')).toEqual({ body: 'performs', mark: '*' });
    expect(splitTrailingMark('نتائج*')).toEqual({ body: 'نتائج', mark: '*' });
    expect(splitTrailingMark('word**')).toEqual({ body: 'word', mark: '**' });
  });

  it('leaves a word without a mark, and a word that is only marks, alone', () => {
    expect(splitTrailingMark('performs')).toEqual({ body: 'performs', mark: '' });
    expect(splitTrailingMark('*')).toEqual({ body: '*', mark: '' });
    expect(splitTrailingMark('a*b')).toEqual({ body: 'a*b', mark: '' });
  });
});

describe('slideInterval — the testimonials section’s intervalMs', () => {
  it('uses an authored interval inside the schema bounds', () => {
    expect(slideInterval('4000')).toBe(4000);
    expect(slideInterval('15000')).toBe(15000);
  });

  it('falls back to the design’s 7 s for anything else', () => {
    for (const raw of [undefined, '', 'abc', '3999', '15001', '7000.5']) {
      expect(slideInterval(raw), String(raw)).toBe(SLIDE_MS);
    }
    expect(SLIDE_MS).toBe(7000);
  });
});
