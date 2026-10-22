import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PURGE_BACKENDS } from '@/lib/http/purge';

// A cache layer is switched on only with a purge that reaches it (Admin v2 R7; README "Workers
// Cache misconfiguration"). The purge seam (src/lib/http/purge.ts) purges a Cloudflare ZONE's
// cache by Cache-Tag. Two other layers would store Tier A responses where that purge does not
// reach, for a year (`s-maxage=31536000`), and their hits skip the Worker, so maintenance mode
// and page visibility would not apply to them either:
//   • Workers Cache (`wrangler.jsonc` `cache`), purged through `ctx.cache.purge`;
//   • Astro's route cache (`astro.config.mjs` `cache` / `routeRules`, the adapter's
//     `cacheCloudflare()` or `memoryCache()`), purged through Astro's own invalidation.
// Neither backend is built, so neither layer may be switched on: this fails the PR that tries,
// until PURGE_BACKENDS names its backend (and maintenance purges everything when it goes on).

/** The file without its comments, so a comment naming a key does not count as setting it. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/.*$/gm, '$1');
}

describe('cache layers and their purge', () => {
  it('the seam purges the zone, and only the zone', () => {
    expect([...PURGE_BACKENDS]).toEqual(['zone']);
  });

  it('Workers Cache is off (wrangler.jsonc has no cache key) unless its purge exists', () => {
    const wrangler = code('wrangler.jsonc');
    const on = /"cache"\s*:/.test(wrangler);
    expect(on && !PURGE_BACKENDS.includes('workers-cache' as never)).toBe(false);
  });

  it('Astro’s route cache is off (no cache provider, no routeRules) unless its purge exists', () => {
    const config = code('astro.config.mjs');
    const on =
      /\bcache\s*:\s*\{/.test(config) ||
      /\brouteRules\s*:/.test(config) ||
      /\b(cacheCloudflare|memoryCache)\s*\(/.test(config);
    expect(on && !PURGE_BACKENDS.includes('astro-cache' as never)).toBe(false);
  });

  it('the check sees a layer switched on (it is not vacuous)', () => {
    expect(/"cache"\s*:/.test('{ "cache": { "enabled": true } }')).toBe(true);
    expect(/\bcache\s*:\s*\{/.test('defineConfig({ cache: { provider: memoryCache() } })')).toBe(
      true,
    );
  });
});
