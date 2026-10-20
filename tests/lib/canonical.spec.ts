import { describe, expect, it } from 'vitest';
import { canonicalPath, localizedCanonical } from '@/lib/seo/canonical';
import { entityPath, pagePath } from '@/lib/seo/entityPaths';
import { isNoindex, pageRobots } from '@/lib/seo/robots';
import { PUBLIC_SITE_URL as SITE } from '../stubs/astro-env-client';

// A canonical override (Admin v2 U10 D6): a site path, localized per language so each
// language stays self-canonical (CLAUDE.md Pillar 3); a legacy absolute URL on this origin
// is read as its path; anything else is ignored, never emitted.

const BASE = SITE.replace(/\/$/, '');
const OTHER = 'https://evil.example';

describe('canonicalPath', () => {
  it.each([
    ['/services/logo', '/services/logo'],
    ['/', '/'],
    [' /about ', '/about'],
    // Legacy absolute values on this origin read as their path, an /ar prefix dropped.
    [`${BASE}/services/logo`, '/services/logo'],
    [`${BASE}/ar/services/logo`, '/services/logo'],
    [`${BASE}/ar`, '/'],
    [`${BASE}/ar/`, '/'],
    // A query or fragment is not part of a canonical path.
    [`${BASE}/services/logo?x=1#y`, '/services/logo'],
  ])('%j is the path %j', (override, path) => {
    expect(canonicalPath(override, BASE)).toBe(path);
  });

  it.each([
    [null],
    [undefined],
    [''],
    ['   '],
    [`${OTHER}/services/logo`],
    ['//evil.example/x'],
    ['/\\evil.example/x'],
    ['javascript:alert(1)'],
    [`https://user:pw@${new URL(BASE).host}/x`],
    ['http://[bad'],
  ])('%j is ignored', (override) => {
    expect(canonicalPath(override as string | null | undefined, BASE)).toBeNull();
  });
});

describe('localizedCanonical', () => {
  const fallbackEn = `${BASE}/services/logo`;
  const fallbackAr = `${BASE}/ar/services/logo`;

  it('without an override, the page itself in each language (byte for byte as before)', () => {
    expect(localizedCanonical(undefined, 'en', BASE, fallbackEn)).toBe(fallbackEn);
    expect(localizedCanonical(undefined, 'ar', BASE, fallbackAr)).toBe(fallbackAr);
  });

  it('an override is localized: the Arabic twin points at the Arabic page', () => {
    expect(localizedCanonical('/services/branding', 'en', BASE, fallbackEn)).toBe(
      `${BASE}/services/branding`,
    );
    expect(localizedCanonical('/services/branding', 'ar', BASE, fallbackAr)).toBe(
      `${BASE}/ar/services/branding`,
    );
    expect(localizedCanonical('/', 'ar', BASE, fallbackAr)).toBe(`${BASE}/ar`);
  });

  it('a legacy absolute override is localized the same way', () => {
    expect(localizedCanonical(`${BASE}/services/branding`, 'ar', BASE, fallbackAr)).toBe(
      `${BASE}/ar/services/branding`,
    );
  });

  it('another origin falls back to the page itself', () => {
    expect(localizedCanonical(`${OTHER}/x`, 'en', BASE, fallbackEn)).toBe(fallbackEn);
    expect(localizedCanonical(`${OTHER}/x`, 'ar', BASE, fallbackAr)).toBe(fallbackAr);
  });
});

describe('entityPath', () => {
  it('names each kind of SEO target', () => {
    expect(entityPath('service', 'logo')).toBe('/services/logo');
    expect(entityPath('portfolio', 'rider')).toBe('/portfolio/rider');
    expect(entityPath('blog_post', 'hello')).toBe('/creative-knowledge/hello');
    expect(entityPath('page', 'home')).toBe('/');
    expect(entityPath('page', 'portfolio-all')).toBe('/portfolio/all');
    expect(entityPath('page', 'unknown')).toBeNull();
    expect(entityPath('service', null)).toBeNull();
    expect(pagePath('toString')).toBeNull();
  });
});

describe('robots, read leniently', () => {
  it.each([
    [null, false, null],
    ['', false, null],
    ['index,follow', false, 'index,follow'],
    ['index, follow', false, 'index,follow'],
    ['noindex', true, 'noindex,follow'],
    ['NOINDEX, NOFOLLOW', true, 'noindex,follow'],
    ['noindex,follow', true, 'noindex,follow'],
  ])('%j: noindex %s, as the editor shows it %j', (stored, noindex, shown) => {
    expect(isNoindex(stored)).toBe(noindex);
    expect(pageRobots(stored)).toBe(shown);
  });
});
