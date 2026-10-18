import { describe, expect, it } from 'vitest';
import {
  SCORE_WEIGHTS,
  UPTIME_OFF,
  UPTIME_UNREAD,
  healthScore,
  scoreLabel,
  uptimePoints,
} from '@/lib/admin/health/score';
import type { CheckState } from '@/lib/admin/health/checklist';

// The site health score (Admin v2 U2, README D8): half field speed (good 100, needs work 50,
// poor 0, over the judged measures), half checklist (ok over ok and fail), the formula
// printed with it; with no speed to judge, the checklist alone, and it says so. Since G2
// (decision D11) uptime from the monitor joins at 40 / 40 / 20, renormalised over the parts
// there are; without a reading the score is U2's, word for word, with why uptime is out.

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
      'Speed from real visits (half) and the checklist (half). Uptime is not set up yet.',
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
      'The checklist alone: there are not enough real visits yet to judge speed. Uptime is not set up yet.',
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
    expect(score.formula).toBe('Nothing to score yet. Uptime is not set up yet.');
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

describe('healthScore with uptime (G2)', () => {
  it('weighs speed 40, the checklist 40 and uptime 20', () => {
    expect(SCORE_WEIGHTS).toEqual({ speed: 40, checks: 40, uptime: 20 });
    const score = healthScore({
      vitals: ['good', 'needs-work', 'poor'], // 50
      checks: checks('ok', 'ok', 'ok', 'fail'), // 75
      uptime: { ratio30: 99.96 }, // 96
    });
    expect(score.uptimePart).toBeCloseTo(96, 6);
    // 0.4 x 50 + 0.4 x 75 + 0.2 x 96 = 69.2
    expect(score.total).toBe(69);
    expect(score.formula).toBe(
      'Speed from real visits (40%), the checklist (40%) and uptime from the monitor (20%).',
    );
  });

  it.each([
    [99, 0],
    [98.2, 0],
    [99.5, 50],
    [99.96, 96],
    [100, 100],
  ])('uptime at %s%% is worth %s points', (ratio, points) => {
    expect(uptimePoints(ratio)).toBeCloseTo(points, 6);
  });

  it('renormalises over the parts there are', () => {
    const noSpeed = healthScore({
      vitals: [null],
      checks: checks('ok', 'fail'), // 50
      uptime: { ratio30: 100 }, // 100
    });
    // 40 / 60 x 50 + 20 / 60 x 100 = 66.7
    expect(noSpeed.total).toBe(67);
    expect(noSpeed.formula).toBe(
      'The checklist (67%) and uptime from the monitor (33%): there are not enough real visits yet to judge speed.',
    );
    const noChecks = healthScore({
      vitals: ['good'],
      checks: checks('info'),
      uptime: { ratio30: 99 },
    });
    expect(noChecks.total).toBe(67);
    expect(noChecks.formula).toMatch(
      /^Speed from real visits \(67%\) and uptime from the monitor \(33%\)/,
    );
    const alone = healthScore({ vitals: [], checks: [], uptime: { ratio30: 99.5 } });
    expect(alone.total).toBe(50);
    expect(alone.formula).toMatch(/^Uptime from the monitor alone/);
  });

  it('without a reading is exactly U2’s score, saying why uptime is out', () => {
    const input = { vitals: ['good', 'poor'] as const, checks: checks('ok', 'fail', 'ok') };
    const u2 = healthScore({ vitals: [...input.vitals], checks: input.checks });
    for (const uptime of ['off', 'unknown'] as const) {
      const score = healthScore({ vitals: [...input.vitals], checks: input.checks, uptime });
      expect(score.total).toBe(u2.total);
      expect(score.vitalsPart).toBe(u2.vitalsPart);
      expect(score.checksPart).toBe(u2.checksPart);
      expect(score.uptimePart).toBeNull();
      expect(score.formula).toMatch(
        /^Speed from real visits \(half\) and the checklist \(half\)\. /,
      );
    }
    expect(healthScore({ ...input, vitals: [...input.vitals], uptime: 'off' }).formula).toContain(
      UPTIME_OFF,
    );
    expect(
      healthScore({ ...input, vitals: [...input.vitals], uptime: 'unknown' }).formula,
    ).toContain(UPTIME_UNREAD);
    expect(UPTIME_OFF).toBe('Uptime is not set up yet.');
    expect(UPTIME_UNREAD).toBe('Uptime could not be read just now.');
  });

  it('never uses a dash in what it prints (P-12)', () => {
    for (const [vitals, list] of [
      [['good'], checks('ok')],
      [[null], checks('ok')],
      [['good'], []],
      [[], []],
    ] as const) {
      const formula = healthScore({
        vitals: [...vitals],
        checks: [...list],
        uptime: { ratio30: 99.9 },
      }).formula;
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
