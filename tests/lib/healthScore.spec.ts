import { describe, expect, it } from 'vitest';
import { healthScore, scoreLabel } from '@/lib/admin/health/score';
import type { CheckState } from '@/lib/admin/health/checklist';

// The site health score (Admin v2 U2, README D8): half field speed (good 100, needs work 50,
// poor 0, over the judged measures), half checklist (ok over ok and fail), the formula
// printed with it; with no speed to judge, the checklist alone, and it says so.

const checks = (...states: CheckState[]) => states.map((state) => ({ state }));

describe('healthScore', () => {
  it('is half speed and half checklist', () => {
    const score = healthScore({
      vitals: ['good', 'needs-work', 'poor'], // (100 + 50 + 0) / 3 = 50
      checks: checks('ok', 'ok', 'ok', 'fail'), // 75
    });
    expect(score.vitalsPart).toBe(50);
    expect(score.checksPart).toBe(75);
    expect(score.total).toBe(63); // 62.5, rounded
    expect(score.formula).toBe(
      'Speed from real visits (half) and the checklist (half). Uptime is not measured here yet.',
    );
  });

  it('leaves info and unknown rows out of the checklist part', () => {
    const score = healthScore({
      vitals: ['good'],
      checks: checks('ok', 'info', 'unknown', 'fail'),
    });
    expect(score.checksPart).toBe(50);
    expect(score.total).toBe(75);
  });

  it('judges speed only on measures with enough visits', () => {
    const score = healthScore({ vitals: ['poor', null, null], checks: checks('ok') });
    expect(score.vitalsPart).toBe(0);
    expect(score.total).toBe(50);
  });

  it('with no speed to judge, is the checklist alone and says so', () => {
    const score = healthScore({ vitals: [null, null, null], checks: checks('ok', 'fail') });
    expect(score.vitalsPart).toBeNull();
    expect(score.total).toBe(50);
    expect(score.formula).toBe(
      'The checklist alone: there are not enough real visits yet to judge speed. Uptime is not measured here yet.',
    );
  });

  it('with nothing judged on the checklist, is speed alone', () => {
    const score = healthScore({ vitals: ['good', 'good'], checks: checks('info', 'unknown') });
    expect(score.checksPart).toBeNull();
    expect(score.total).toBe(100);
    expect(score.formula).toMatch(/^Speed from real visits alone/);
  });

  it('with nothing at all, has no score', () => {
    const score = healthScore({ vitals: [], checks: [] });
    expect(score.total).toBeNull();
    expect(score.formula).toBe('Nothing to score yet. Uptime is not measured here yet.');
  });

  it('never uses a dash in what it prints (P-12)', () => {
    for (const formula of [
      healthScore({ vitals: ['good'], checks: checks('ok') }).formula,
      healthScore({ vitals: [null], checks: checks('ok') }).formula,
      healthScore({ vitals: ['good'], checks: [] }).formula,
      healthScore({ vitals: [], checks: [] }).formula,
    ]) {
      expect(formula).not.toMatch(/[–—]/);
    }
  });
});

describe('scoreLabel', () => {
  it('says the band in words', () => {
    expect(scoreLabel(95)).toBe('Healthy');
    expect(scoreLabel(90)).toBe('Healthy');
    expect(scoreLabel(89)).toBe('Needs attention');
    expect(scoreLabel(70)).toBe('Needs attention');
    expect(scoreLabel(69)).toBe('Problems to fix');
    expect(scoreLabel(null)).toBe('Not scored yet');
  });
});
