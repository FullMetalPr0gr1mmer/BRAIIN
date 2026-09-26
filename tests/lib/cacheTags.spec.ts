import { describe, it, expect, vi } from 'vitest';
import { setTierA, noEdgeCache, tierATags, TIER_A_CACHE_CONTROL } from '@/lib/http/cacheTags';
import { getIdentity } from '@/lib/identity';
import { IDENTITY_FALLBACK } from '@/lib/identity/fallback';

vi.mock('@/lib/data/siteProfile', () => ({
  getSiteProfile: vi.fn(async () => IDENTITY_FALLBACK),
}));

describe('Tier-A cache headers', () => {
  it('always tags the identity and the navigation, which every page renders', () => {
    const tags = tierATags({ route: 'about', locale: 'ar', entities: ['team:all'] });
    expect(tags).toEqual([
      'tenant:default',
      'site:identity',
      'nav:all',
      'route:about',
      'team:all',
      'locale:ar',
    ]);
  });

  it('sets the long edge TTL and a comma-joined Cache-Tag', () => {
    const response = { headers: new Headers() };
    setTierA(response, { route: 'service', locale: 'en', entities: ['service:branding'] });
    expect(response.headers.get('Cache-Control')).toBe(TIER_A_CACHE_CONTROL);
    expect(response.headers.get('Cache-Tag')).toBe(
      'tenant:default,site:identity,nav:all,route:service,service:branding,locale:en',
    );
  });

  it('de-duplicates and caps at the 30-tag purge limit', () => {
    const many = Array.from({ length: 40 }, (_, i) => `portfolio:p${i}`);
    const tags = tierATags({ route: 'x', locale: 'en', entities: [...many, 'route:x'] });
    expect(tags).toHaveLength(30);
    expect(new Set(tags).size).toBe(30);
  });

  it('noEdgeCache makes a variant uncacheable and drops its tags', () => {
    const response = { headers: new Headers() };
    setTierA(response, { route: 'portfolio-all', locale: 'en' });
    noEdgeCache(response);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Cache-Tag')).toBeNull();
  });
});

describe('getIdentity — one fetch per request', () => {
  it('shares one in-flight fetch between concurrent callers', async () => {
    const { getSiteProfile } = await import('@/lib/data/siteProfile');
    const fetch = vi.mocked(getSiteProfile);
    fetch.mockClear();
    const locals: { identity?: Promise<typeof IDENTITY_FALLBACK> } = {};
    const [a, b, c] = await Promise.all([
      getIdentity(locals),
      getIdentity(locals),
      getIdentity(locals),
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a.brandName.en).toBe('Braiin Statiion');

    // A new request (new locals) fetches again — nothing leaks across requests.
    await getIdentity({});
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
