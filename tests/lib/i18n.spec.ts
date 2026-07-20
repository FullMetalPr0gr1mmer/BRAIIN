import { describe, it, expect } from 'vitest';
import {
  pickLocale,
  localeFromPath,
  dir,
  toLogicalPath,
  localizedPath,
  hreflangAlternates,
} from '@/lib/i18n';

describe('pickLocale', () => {
  const full = { en: 'Branding', ar: 'العلامة التجارية' };

  it('returns the requested locale when present', () => {
    expect(pickLocale(full, 'en')).toBe('Branding');
    expect(pickLocale(full, 'ar')).toBe('العلامة التجارية');
  });

  it('falls back to EN when Arabic is absent — EN is x-default', () => {
    expect(pickLocale({ en: 'Branding' }, 'ar')).toBe('Branding');
  });

  it('treats an empty string as absent (|| not ??)', () => {
    expect(pickLocale({ en: 'Branding', ar: '' }, 'ar')).toBe('Branding');
  });

  it('NEVER falls back from EN to AR — an English page must not render Arabic', () => {
    expect(pickLocale({ en: '', ar: 'العلامة' }, 'en')).toBe('');
    expect(pickLocale({ en: '', ar: 'العلامة' }, 'en', 'slug-fallback')).toBe('slug-fallback');
  });

  it('returns the fallback for null/undefined fields', () => {
    expect(pickLocale(null, 'en', 'my-slug')).toBe('my-slug');
    expect(pickLocale(undefined, 'ar', 'my-slug')).toBe('my-slug');
    expect(pickLocale(null, 'en')).toBe('');
  });
});

describe('locale routing', () => {
  it('derives the locale from the path prefix', () => {
    expect(localeFromPath('/')).toBe('en');
    expect(localeFromPath('/services')).toBe('en');
    expect(localeFromPath('/ar')).toBe('ar');
    expect(localeFromPath('/ar/services')).toBe('ar');
  });

  it('does not treat /arabic or /archive as the Arabic prefix', () => {
    expect(localeFromPath('/archive')).toBe('en');
    expect(localeFromPath('/arabic-guide')).toBe('en');
  });

  it('maps direction for RTL', () => {
    expect(dir('ar')).toBe('rtl');
    expect(dir('en')).toBe('ltr');
  });

  it('round-trips logical ↔ localized paths', () => {
    expect(toLogicalPath('/ar/services')).toBe('/services');
    expect(toLogicalPath('/ar')).toBe('/');
    expect(localizedPath('/services', 'ar')).toBe('/ar/services');
    expect(localizedPath('/', 'ar')).toBe('/ar');
    expect(localizedPath('/', 'en')).toBe('/');
  });
});

describe('hreflang', () => {
  it('emits reciprocal en/ar pairs plus x-default → EN', () => {
    const alts = hreflangAlternates('/services', 'https://x.com/');
    expect(alts).toEqual([
      { hreflang: 'en', href: 'https://x.com/services' },
      { hreflang: 'ar', href: 'https://x.com/ar/services' },
      { hreflang: 'x-default', href: 'https://x.com/services' },
    ]);
  });

  it('x-default always points at the EN twin, never AR', () => {
    const alts = hreflangAlternates('/portfolio', 'https://x.com');
    const xDefault = alts.find((a) => a.hreflang === 'x-default');
    const en = alts.find((a) => a.hreflang === 'en');
    expect(xDefault?.href).toBe(en?.href);
  });
});
