import { describe, it, expect } from 'vitest';
import { TRAINING_DENY, RETRIEVAL_ALLOW, USER_FETCH_ALLOW } from '@/lib/seo/crawlers';
import { GET as robotsGet } from '@/pages/robots.txt';
import { GET as llmsGet } from '@/pages/llms.txt';

// CLAUDE.md Pillar 3 names the exact token set. Asserting against a literal list here —
// rather than against the arrays themselves — is the point: a test that reads
// TRAINING_DENY and checks TRAINING_DENY passes no matter what the map says.
const REQUIRED_DENY = [
  'GPTBot',
  'ClaudeBot',
  'Google-Extended',
  'CCBot',
  'Applebot-Extended',
  'Meta-ExternalAgent',
];
const REQUIRED_ALLOW = ['OAI-SearchBot', 'Claude-SearchBot', 'PerplexityBot', 'Bingbot'];

const call = async (handler: unknown) =>
  await (handler as unknown as () => Response | Promise<Response>)();

describe('AI crawler policy (three tiers)', () => {
  it('every tier is non-empty', () => {
    expect(TRAINING_DENY.length).toBeGreaterThan(0);
    expect(RETRIEVAL_ALLOW.length).toBeGreaterThan(0);
    expect(USER_FETCH_ALLOW.length).toBeGreaterThan(0);
  });

  it('tiers are mutually disjoint (a UA cannot be in two tiers)', () => {
    const all = [...TRAINING_DENY, ...RETRIEVAL_ALLOW, ...USER_FETCH_ALLOW];
    expect(new Set(all).size).toBe(all.length);
  });

  it('denies EVERY training crawler CLAUDE.md names — including Meta-ExternalAgent', () => {
    // Meta-ExternalAgent was previously missing from this assertion while being present
    // in the map: the one token the standard calls out explicitly was the one unguarded.
    for (const ua of REQUIRED_DENY) expect(TRAINING_DENY).toContain(ua);
  });

  it('allows EVERY retrieval crawler CLAUDE.md names — including Bingbot', () => {
    for (const ua of REQUIRED_ALLOW) expect(RETRIEVAL_ALLOW).toContain(ua);
  });
});

// The snapshot test that robots.txt.ts:5 and crawlers.ts:3 both claimed existed. It did
// not — nothing invoked the route, so the map and the emitted file could diverge freely.
describe('/robots.txt is generated from the crawler map', () => {
  it('emits Disallow: / for every training crawler', async () => {
    const body = await (await call(robotsGet)).text();
    for (const ua of REQUIRED_DENY) {
      expect(body).toContain(`User-agent: ${ua}\nDisallow: /\n`);
    }
  });

  it('emits Allow: / for every retrieval and user-fetch crawler', async () => {
    const body = await (await call(robotsGet)).text();
    for (const ua of [...RETRIEVAL_ALLOW, ...USER_FETCH_ALLOW]) {
      expect(body).toContain(`User-agent: ${ua}\nAllow: /`);
    }
  });

  it('never allows a training crawler by accident', async () => {
    const body = await (await call(robotsGet)).text();
    for (const ua of TRAINING_DENY) {
      const block = body.split(`User-agent: ${ua}\n`)[1]?.split('\n\n')[0] ?? '';
      expect(block).toContain('Disallow: /');
      expect(block).not.toContain('Allow: /');
    }
  });

  it('keeps /admin and /api out of the generic crawl', async () => {
    const body = await (await call(robotsGet)).text();
    expect(body).toContain('User-agent: *');
    expect(body).toContain('Disallow: /admin');
    expect(body).toContain('Disallow: /api/');
  });

  it('points at the sitemap and the llms.txt index', async () => {
    const body = await (await call(robotsGet)).text();
    expect(body).toMatch(/Sitemap: https?:\/\/\S+\/sitemap\.xml/);
    expect(body).toContain('/llms.txt');
  });

  it('is served as plain text', async () => {
    expect((await call(robotsGet)).headers.get('content-type')).toContain('text/plain');
  });
});

describe('/llms.txt agrees with the crawler map', () => {
  it('names the same deny and allow tokens rather than restating policy in prose', async () => {
    // llms.txt used to describe the policy in prose while importing nothing from
    // crawlers.ts, so it could contradict robots.txt silently.
    const body = await (await call(llmsGet)).text();
    for (const ua of REQUIRED_DENY) expect(body).toContain(ua);
    for (const ua of REQUIRED_ALLOW) expect(body).toContain(ua);
  });

  it('states no service COUNT — a hardcoded "14 services" drifts from reality', async () => {
    const body = await (await call(llmsGet)).text();
    expect(body).not.toMatch(/\d+\s+services/i);
  });

  it('points at both language roots and defers to robots.txt as authoritative', async () => {
    const body = await (await call(llmsGet)).text();
    expect(body).toContain('/ar/');
    expect(body).toContain('robots.txt');
  });
});
