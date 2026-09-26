import { describe, it, expect } from 'vitest';
import { isCurrentNav } from '@/lib/nav/current';

describe('isCurrentNav', () => {
  it('matches the locale root EXACTLY — Home is not current on every /ar page', () => {
    // The defect: `/ar` prefix-matched `/ar/about`, so Arabic Home carried
    // aria-current="page" on the whole Arabic site.
    expect(isCurrentNav('/ar', '/ar')).toBe(true);
    expect(isCurrentNav('/ar', '/ar/')).toBe(true);
    expect(isCurrentNav('/ar', '/ar/about')).toBe(false);
    expect(isCurrentNav('/', '/')).toBe(true);
    expect(isCurrentNav('/', '/about')).toBe(false);
  });

  it('treats a fragment href as an anchor, never as the current page', () => {
    expect(isCurrentNav('/#services', '/')).toBe(false);
    expect(isCurrentNav('/ar#services', '/ar')).toBe(false);
  });

  it('matches a section and its sub-pages, but not a sibling that shares a prefix', () => {
    expect(isCurrentNav('/portfolio', '/portfolio')).toBe(true);
    expect(isCurrentNav('/portfolio', '/portfolio/the-rider')).toBe(true);
    expect(isCurrentNav('/ar/portfolio', '/ar/portfolio/all')).toBe(true);
    expect(isCurrentNav('/portfolio', '/portfolio-archive')).toBe(false);
    expect(isCurrentNav('/about/', '/about')).toBe(true);
  });

  it('ignores a query string on the target', () => {
    expect(isCurrentNav('/portfolio/all?year=2026', '/portfolio/all')).toBe(true);
  });

  it('never marks an off-site or protocol-relative link current', () => {
    expect(isCurrentNav('https://instagram.com/x', '/')).toBe(false);
    expect(isCurrentNav('//evil.example/', '/')).toBe(false);
    expect(isCurrentNav('mailto:hello@braiinstatiion.com', '/')).toBe(false);
  });
});
