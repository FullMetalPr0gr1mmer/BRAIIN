import { describe, it, expect } from 'vitest';
import { TRAINING_DENY, RETRIEVAL_ALLOW, USER_FETCH_ALLOW } from '@/lib/seo/crawlers';

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

  it('denies the known training crawlers', () => {
    for (const ua of ['GPTBot', 'ClaudeBot', 'Google-Extended', 'CCBot', 'Applebot-Extended']) {
      expect(TRAINING_DENY).toContain(ua);
    }
  });

  it('allows the retrieval/citation crawlers (the AEO surface)', () => {
    for (const ua of ['OAI-SearchBot', 'Claude-SearchBot', 'PerplexityBot']) {
      expect(RETRIEVAL_ALLOW).toContain(ua);
    }
  });
});
