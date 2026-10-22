import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PURGE_BACKENDS } from '@/lib/http/purge';

// A cache layer is switched on only with a purge that reaches it (Admin v2 R7; README "Workers
// Cache misconfiguration"). The purge seam (src/lib/http/purge.ts) purges a Cloudflare ZONE's
// cache by Cache-Tag: the Tier A cache the Worker itself reads and fills through the Cache API
// (releases.md §5.3), which may be looked up only in src/middleware.ts, after the maintenance
// and page-visibility checks, so both hold for a cached page with no purge (CLAUDE.md §3,
// "pre-cache"). Two other layers would store Tier A responses where that purge does not
// reach, for a year (`s-maxage=31536000`), and their hits skip the middleware, so maintenance
// mode and page visibility would not apply to them either:
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

/** Every source file under a directory. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx|mts|js|mjs|astro)$/.test(name) ? [path.split('\\').join('/')] : [];
  });
}

/**
 * The files that look a response up in the Cache API where the pre-cache checks have not run:
 * anywhere but the middleware, or in the middleware before its maintenance check or its
 * page-visibility check.
 */
function lookupsBeforeTheChecks(files: Readonly<Record<string, string>>): string[] {
  const out: string[] = [];
  for (const [path, text] of Object.entries(files)) {
    const at = text.search(/\bcaches\s*\.\s*(default|open)\b/);
    if (at < 0) continue;
    if (path !== 'src/middleware.ts') {
      out.push(path);
      continue;
    }
    const maintenance = text.indexOf('getMaintenanceState(');
    const visibility = text.indexOf('getVisibilitySnapshot(');
    if (maintenance < 0 || visibility < 0 || at < maintenance || at < visibility) out.push(path);
  }
  return out;
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

  it('a Tier A cache lookup sits only in the middleware, after maintenance and page visibility', () => {
    const files = Object.fromEntries(sources('src').map((path) => [path, code(path)]));
    expect(lookupsBeforeTheChecks(files)).toEqual([]);
  });

  it('the lookup check sees a lookup before the checks (it is not vacuous)', () => {
    const lookup = 'const hit = await caches.default.match(request);';
    const checks = 'await getMaintenanceState(env); await getVisibilitySnapshot(env);';
    expect(lookupsBeforeTheChecks({ 'src/worker.ts': lookup })).toEqual(['src/worker.ts']);
    expect(lookupsBeforeTheChecks({ 'src/middleware.ts': `${lookup}${checks}` })).toEqual([
      'src/middleware.ts',
    ]);
    expect(lookupsBeforeTheChecks({ 'src/middleware.ts': `${checks}${lookup}` })).toEqual([]);
    expect(lookupsBeforeTheChecks({ 'src/x.ts': 'await caches.open("tier-a")' })).toEqual([
      'src/x.ts',
    ]);
  });

  it('the check sees a layer switched on (it is not vacuous)', () => {
    expect(/"cache"\s*:/.test('{ "cache": { "enabled": true } }')).toBe(true);
    expect(/\bcache\s*:\s*\{/.test('defineConfig({ cache: { provider: memoryCache() } })')).toBe(
      true,
    );
  });
});
