import { describe, it, expect } from 'vitest';
import { countLabel, pluralCategory } from '@/lib/i18n/plural';
import { initials } from '@/lib/text/initials';

const PROJECTS_AR = {
  zero: 'لا مشاريع',
  one: 'مشروع واحد',
  two: 'مشروعان',
  few: '{n} مشاريع',
  many: '{n} مشروعًا',
  other: '{n} مشروع',
};
const PROJECTS_EN = { one: '{n} project', other: '{n} projects' };

describe('countLabel', () => {
  it('picks every Arabic plural category, not one word for all counts', () => {
    expect(countLabel(0, PROJECTS_AR, 'ar')).toBe('لا مشاريع');
    expect(countLabel(1, PROJECTS_AR, 'ar')).toBe('مشروع واحد');
    expect(countLabel(2, PROJECTS_AR, 'ar')).toBe('مشروعان');
    expect(countLabel(3, PROJECTS_AR, 'ar')).toBe('03 مشاريع');
    expect(countLabel(10, PROJECTS_AR, 'ar')).toBe('10 مشاريع');
    expect(countLabel(11, PROJECTS_AR, 'ar')).toBe('11 مشروعًا');
    expect(countLabel(99, PROJECTS_AR, 'ar')).toBe('99 مشروعًا');
    expect(countLabel(100, PROJECTS_AR, 'ar')).toBe('100 مشروع');
    // 102 is "other" in Arabic, not "two" — hand-written ranges get this wrong.
    expect(pluralCategory(102, 'ar')).toBe('other');
  });

  it('English needs only one/other, zero-padded as the mockup counts', () => {
    expect(countLabel(1, PROJECTS_EN, 'en')).toBe('01 project');
    expect(countLabel(12, PROJECTS_EN, 'en')).toBe('12 projects');
    expect(countLabel(0, PROJECTS_EN, 'en')).toBe('00 projects');
    expect(countLabel(7, PROJECTS_EN, 'en', { pad: 0 })).toBe('7 projects');
  });

  it('falls back to `other` for a category the caller did not supply', () => {
    expect(countLabel(2, { other: '{n} items' }, 'ar')).toBe('02 items');
  });

  it('inserts the number verbatim even if a form contains $-patterns', () => {
    expect(countLabel(5, { other: '$& {n}' }, 'en')).toBe('$& 05');
  });
});

describe('initials', () => {
  it('takes the first letter of the first two words, uppercased', () => {
    expect(initials('Client name')).toBe('CN');
    expect(initials('  sara   al-harbi  extra ')).toBe('SA');
    expect(initials('Madonna')).toBe('M');
    expect(initials('')).toBe('');
  });

  it('skips a leading Arabic definite article', () => {
    // The mockup's naive rule gives "اا" for this name.
    expect(initials('اسم العميل')).toBe('اع');
    // A two-letter word that IS "ال"-shaped is kept whole.
    expect(initials('ال ب')).toBe('اب');
  });

  it('never splits a grapheme cluster', () => {
    expect(initials('👩🏽‍🎨 Studio')).toBe('👩🏽‍🎨S');
  });
});
