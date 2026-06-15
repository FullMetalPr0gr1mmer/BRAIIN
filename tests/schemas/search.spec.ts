import { describe, it, expect } from 'vitest';
import { SearchQuerySchema, SearchHitSchema, hasControlChars } from '@schemas/search';

// Control chars are built via fromCharCode so the test source stays plain ASCII.
const NUL = String.fromCharCode(0x00);
const US = String.fromCharCode(0x1f);
const DEL = String.fromCharCode(0x7f);
const C1 = String.fromCharCode(0x9f);
const TAB = String.fromCharCode(0x09);

describe('SearchQuerySchema (anon search input boundary)', () => {
  it('accepts a minimal valid query and applies defaults', () => {
    const r = SearchQuerySchema.safeParse({ q: 'seo' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.q).toBe('seo');
      expect(r.data.locale).toBe('en');
    }
  });

  it('accepts an Arabic query (no false control-char positive)', () => {
    expect(SearchQuerySchema.safeParse({ q: 'تصميم', locale: 'ar' }).success).toBe(true);
  });

  it('trims surrounding whitespace', () => {
    const r = SearchQuerySchema.safeParse({ q: '  branding  ' });
    expect(r.success && r.data.q).toBe('branding');
  });

  it('rejects too-short (<2) and too-long (>64) queries', () => {
    expect(SearchQuerySchema.safeParse({ q: 'a' }).success).toBe(false);
    expect(SearchQuerySchema.safeParse({ q: 'x'.repeat(65) }).success).toBe(false);
    expect(SearchQuerySchema.safeParse({ q: 'x'.repeat(64) }).success).toBe(true);
  });

  it('rejects control characters (C0, US, DEL, C1, TAB)', () => {
    expect(SearchQuerySchema.safeParse({ q: `ab${NUL}cd` }).success).toBe(false);
    expect(SearchQuerySchema.safeParse({ q: `ab${US}cd` }).success).toBe(false);
    expect(SearchQuerySchema.safeParse({ q: `ab${DEL}cd` }).success).toBe(false);
    expect(SearchQuerySchema.safeParse({ q: `ab${C1}cd` }).success).toBe(false);
    expect(SearchQuerySchema.safeParse({ q: `line${TAB}break` }).success).toBe(false);
  });

  it('exposes only q + locale (no client-supplied limit; server caps rows)', () => {
    const r = SearchQuerySchema.safeParse({ q: 'seo' });
    expect(r.success).toBe(true);
    if (r.success) expect(Object.keys(r.data).sort()).toEqual(['locale', 'q']);
  });

  it('rejects an unknown locale', () => {
    expect(SearchQuerySchema.safeParse({ q: 'seo', locale: 'fr' }).success).toBe(false);
  });
});

describe('hasControlChars helper', () => {
  it('is false for printable Latin + Arabic + punctuation', () => {
    expect(hasControlChars('Hello, world! تصميم 2026')).toBe(false);
  });
  it('is true when a control char is present', () => {
    expect(hasControlChars(`a${TAB}b`)).toBe(true);
    expect(hasControlChars(`a${NUL}b`)).toBe(true);
  });
});

describe('SearchHitSchema (RPC row validation)', () => {
  it('accepts a well-formed hit', () => {
    const hit = {
      entity_type: 'service',
      slug: 'branding',
      title: { en: 'Branding', ar: 'الهوية' },
      snippet: 'Identity systems…',
      rank: 0.42,
    };
    expect(SearchHitSchema.safeParse(hit).success).toBe(true);
  });

  it('rejects an unknown entity_type', () => {
    const bad = { entity_type: 'user', slug: 'x', title: {}, snippet: null, rank: 0 };
    expect(SearchHitSchema.safeParse(bad).success).toBe(false);
  });

  it('allows a null snippet (suggestions have none)', () => {
    const hit = { entity_type: 'blog', slug: 'p', title: { en: 'P' }, snippet: null, rank: 0.2 };
    expect(SearchHitSchema.safeParse(hit).success).toBe(true);
  });
});
