import { describe, it, expect } from 'vitest';
import { underSpendCap, ZeroSpendStore, AI_DAILY_USD_CAP } from '@/lib/ai/spendCap';

describe('AI daily spend cap', () => {
  it('passes under the cap (zero spend at the 501 stub)', async () => {
    const r = await underSpendCap(new ZeroSpendStore(), 'global');
    expect(r.ok).toBe(true);
    expect(r.spent).toBe(0);
    expect(r.cap).toBe(AI_DAILY_USD_CAP);
  });

  it('blocks at or over the cap (breaker open)', async () => {
    const atCap = { spentTodayUsd: async () => AI_DAILY_USD_CAP };
    expect((await underSpendCap(atCap, 'global')).ok).toBe(false);
    const overCap = { spentTodayUsd: async () => AI_DAILY_USD_CAP + 10 };
    expect((await underSpendCap(overCap, 'global')).ok).toBe(false);
  });

  it('passes just under the cap', async () => {
    const underCap = { spentTodayUsd: async () => AI_DAILY_USD_CAP - 0.01 };
    expect((await underSpendCap(underCap, 'global')).ok).toBe(true);
  });
});
