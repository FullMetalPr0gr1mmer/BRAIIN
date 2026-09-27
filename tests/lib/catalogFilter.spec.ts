import { describe, it, expect } from 'vitest';
import { hrefFor, isFacet, nextSelection, readValues, withFacet } from '@/lib/client/catalogFilter';

// The pure half of the catalogue enhancement (src/lib/client/catalogFilter.ts). The DOM
// half runs in tests/e2e/projects-catalog.e2e.ts and work-page.e2e.ts against a browser.

describe('nextSelection — what an activated control does', () => {
  it('a value toggles: on when off, off when it is the active one', () => {
    expect(nextSelection({}, 'service', 'branding')).toEqual({ service: 'branding' });
    expect(nextSelection({ service: 'branding' }, 'service', 'branding')).toEqual({});
    expect(nextSelection({ service: 'branding' }, 'service', 'music')).toEqual({
      service: 'music',
    });
  });

  it('an empty value clears that facet only (a pill, "All services")', () => {
    expect(nextSelection({ service: 'branding', year: '2026' }, 'service', '')).toEqual({
      year: '2026',
    });
  });

  it('"all" clears everything (Clear filters)', () => {
    expect(nextSelection({ service: 'branding', year: '2026' }, 'all', '')).toEqual({});
  });

  it('never mutates the selection it was given', () => {
    const before = { service: 'branding' };
    nextSelection(before, 'service', '');
    nextSelection(before, 'year', '2026');
    expect(before).toEqual({ service: 'branding' });
  });
});

describe('withFacet — a select sets, never toggles', () => {
  it('sets, replaces and clears', () => {
    expect(withFacet({}, 'sector', 'automotive')).toEqual({ sector: 'automotive' });
    expect(withFacet({ sector: 'automotive' }, 'sector', 'automotive')).toEqual({
      sector: 'automotive',
    });
    expect(withFacet({ sector: 'automotive', year: '2026' }, 'sector', '')).toEqual({
      year: '2026',
    });
  });
});

describe('hrefFor', () => {
  it('builds the page URL in FACETS order, with the fragment last', () => {
    expect(hrefFor('/ar/portfolio', { year: '2026', service: 'branding' }, '#projects')).toBe(
      '/ar/portfolio?service=branding&year=2026#projects',
    );
    expect(hrefFor('/portfolio/all', {})).toBe('/portfolio/all');
  });

  it('encodes whatever it is given (values are validated before they get here anyway)', () => {
    expect(hrefFor('/portfolio/all', { client: 'a&b=c' })).toBe('/portfolio/all?client=a%26b%3Dc');
  });
});

describe('readValues / isFacet — markup is re-validated, never trusted', () => {
  it('keeps facet keys and string values only', () => {
    expect(
      readValues({ service: ['branding', 3, null], year: ['2026'], evil: ['x'], sector: 'no' }),
    ).toEqual({ service: ['branding'], year: ['2026'] });
    expect(readValues(null)).toEqual({});
    expect(readValues('service')).toEqual({});
  });

  it('isFacet accepts the four facets only', () => {
    for (const f of ['service', 'sector', 'client', 'year']) expect(isFacet(f)).toBe(true);
    for (const f of ['all', '', undefined, 'constructor', '__proto__']) {
      expect(isFacet(f)).toBe(false);
    }
  });
});
