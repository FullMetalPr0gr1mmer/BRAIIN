import { describe, it, expect } from 'vitest';
import {
  MemoryRateStore,
  checkRateLimits,
  styleFinderRules,
  AI_IP_LIMIT,
  AI_SESSION_LIMIT,
  HOUR_MS,
} from '@/lib/ai/rateLimit';

// CLAUDE.md §9(g): the 61st per-IP / 21st per-session call is blocked BEFORE any upstream
// spend. Since the endpoint evaluates this before its (stubbed) model logic and returns 429
// on block, "zero upstream call" is guaranteed when checkRateLimits reports ok=false.

describe('AI Style-Finder rate limits', () => {
  it('blocks the 21st per-session call within the hour', async () => {
    const store = new MemoryRateStore(() => 1000); // frozen clock
    const session = 'sess-abcd1234';
    // vary IP each call so ONLY the session counter accumulates
    for (let i = 1; i <= AI_SESSION_LIMIT; i++) {
      const r = await checkRateLimits(store, styleFinderRules(`ip-${i}`, session));
      expect(r.ok).toBe(true);
    }
    const blocked = await checkRateLimits(store, styleFinderRules('ip-last', session));
    expect(blocked.ok).toBe(false);
    expect(blocked.blocked).toBe(`sf:session:${session}`);
  });

  it('blocks the 61st per-IP call within the hour', async () => {
    const store = new MemoryRateStore(() => 1000);
    const ip = '203.0.113.7';
    // vary session each call so ONLY the IP counter accumulates
    for (let i = 1; i <= AI_IP_LIMIT; i++) {
      const r = await checkRateLimits(
        store,
        styleFinderRules(ip, `sess-${String(i).padStart(8, '0')}`),
      );
      expect(r.ok).toBe(true);
    }
    const blocked = await checkRateLimits(store, styleFinderRules(ip, 'sess-finalxx'));
    expect(blocked.ok).toBe(false);
    expect(blocked.blocked).toBe(`sf:ip:${ip}`);
  });

  it('resets the counter after the window elapses', async () => {
    let now = 0;
    const store = new MemoryRateStore(() => now);
    const rules = [{ key: 'k', limit: 2, windowMs: HOUR_MS }];
    expect((await checkRateLimits(store, rules)).ok).toBe(true);
    expect((await checkRateLimits(store, rules)).ok).toBe(true);
    expect((await checkRateLimits(store, rules)).ok).toBe(false); // 3rd blocked
    now += HOUR_MS; // window passes
    expect((await checkRateLimits(store, rules)).ok).toBe(true); // fresh window
  });

  it('MemoryRateStore increments then resets per key', async () => {
    let now = 0;
    const store = new MemoryRateStore(() => now);
    expect(await store.hit('a', HOUR_MS)).toBe(1);
    expect(await store.hit('a', HOUR_MS)).toBe(2);
    expect(await store.hit('b', HOUR_MS)).toBe(1); // separate key
    now += HOUR_MS;
    expect(await store.hit('a', HOUR_MS)).toBe(1); // reset
  });
});
