import { describe, it, expect } from 'vitest';
import {
  FILTER_STR,
  featuredCount,
  projectCount,
  removeLabel,
  seeAllLabel,
} from '@/lib/portfolio/filterText';

// The filter bar's own words — built-in chrome, shared by the server render and the
// browser enhancement. Verbatim from the mockup's catalogue I18N, except the Arabic count
// noun, which follows the Arabic plural categories (the mockup always wrote "مشاريع").

describe('project count', () => {
  it('English: one / other, zero-padded as the mockup counts', () => {
    expect(projectCount(1, 'en')).toBe('01 project');
    expect(projectCount(0, 'en')).toBe('00 projects');
    expect(projectCount(12, 'en')).toBe('12 projects');
  });

  it('Arabic: the noun follows the plural category', () => {
    expect(projectCount(1, 'ar')).toBe('01 مشروع');
    expect(projectCount(2, 'ar')).toBe('02 مشروعان');
    expect(projectCount(3, 'ar')).toBe('03 مشاريع');
    expect(projectCount(10, 'ar')).toBe('10 مشاريع');
    expect(projectCount(11, 'ar')).toBe('11 مشروعًا');
    expect(projectCount(12, 'ar')).toBe('12 مشروعًا');
    expect(projectCount(99, 'ar')).toBe('99 مشروعًا');
    expect(projectCount(100, 'ar')).toBe('100 مشروع');
    expect(projectCount(0, 'ar')).toBe('00 مشروع');
  });
});

describe('featured count (Our Work)', () => {
  it('matches the mockup in both languages', () => {
    expect(featuredCount(6, 6, 'en')).toBe('06 of 06 featured');
    expect(featuredCount(2, 6, 'ar')).toBe('02 من 06 مختارة');
    expect(featuredCount(0, 12, 'en')).toBe('00 of 12 featured');
  });
});

describe('see-all label', () => {
  it('is the plain label with no filter, the matching count with one', () => {
    expect(seeAllLabel(null, 'en')).toBe('See all projects');
    expect(seeAllLabel(4, 'en')).toBe('See all 4 matching projects');
    expect(seeAllLabel(null, 'ar')).toBe('شوف كل المشاريع');
    expect(seeAllLabel(4, 'ar')).toBe('شوف كل المشاريع المطابقة (4)');
    expect(seeAllLabel(0, 'en')).toBe('See all 0 matching projects');
  });
});

describe('chrome strings', () => {
  it('a pill is named by its visible text first, then the action (WCAG 2.5.3)', () => {
    expect(removeLabel('sector', 'Automotive', 'en')).toBe('Sector: Automotive, remove filter');
    expect(removeLabel('sector', 'السيارات', 'ar')).toBe('القطاع: السيارات، إزالة الفلتر');
    expect(removeLabel('year', '2026', 'en').startsWith('Year: 2026')).toBe(true);
  });

  it('every string exists in both languages (none left empty)', () => {
    const walk = (v: unknown): string[] =>
      typeof v === 'string' ? [v] : Object.values(v as object).flatMap(walk);
    for (const locale of ['en', 'ar'] as const) {
      for (const text of walk(FILTER_STR[locale])) expect(text.trim()).not.toBe('');
    }
    expect(Object.keys(FILTER_STR.ar).sort()).toEqual(Object.keys(FILTER_STR.en).sort());
  });

  it('keeps the mockup copy verbatim', () => {
    expect(FILTER_STR.en.none).toBe('No projects match these filters.');
    expect(FILTER_STR.ar.none).toBe('ما في مشاريع تطابق هذه الفلاتر.');
    expect(FILTER_STR.ar.clear).toBe('امسح الفلاتر');
    expect(FILTER_STR.ar.filterBy).toBe('فلترة حسب');
    expect(FILTER_STR.en.all).toEqual({
      service: 'All services',
      sector: 'All sectors',
      client: 'All clients',
      year: 'All years',
    });
  });
});
