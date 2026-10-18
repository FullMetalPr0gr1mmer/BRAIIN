import { describe, expect, it } from 'vitest';
import { THRESHOLDS } from '@/lib/health/thresholds';
import { TIMING } from '@/lib/health/probes';
import { STALE_RETRY_HOURS, failedReadLine, noReadingLine } from '@/lib/admin/health/uptime';

// The Uptime card's words for a probe without a fresh reading (Admin v2 G2,
// src/lib/admin/health/uptime.ts): one line per state, each true whatever led to it. Six
// failures can come from Check now within minutes, so no line claims an hour; once stale the
// backoff is 6 hours with ±20% jitter plus a run of the schedule, so no line says "at most
// every 6 hours".

const NOW = Date.parse('2026-10-15T12:00:00Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const at = (failures: number, readOk = false, okAt: string | null = null) => ({
  failures,
  readOk,
  okAt,
});

const FALSE_CLAIMS = [/for an hour/, /at most every 6 hours/, /just now/, /due within/];

describe('noReadingLine: the card with no reading to show', () => {
  it('no row yet, or a run that has not tried: not checked yet', () => {
    expect(noReadingLine(null)).toBe('Not checked yet. Readings arrive every 10 minutes.');
  });

  it('a reading that came in but cannot be shown says so, not "not checked"', () => {
    expect(noReadingLine(at(0, true, '2026-10-15T11:50:00Z'))).toBe(
      'The last reading could not be shown. Readings arrive every 10 minutes.',
    );
  });

  it('never read, failing but not stale: the tries counted, asked again every 10 minutes', () => {
    expect(noReadingLine(at(1))).toBe(
      'No reading yet: the monitor did not answer the last try. It is asked again every 10 minutes.',
    );
    expect(noReadingLine(at(THRESHOLDS.staleAfter - 1))).toBe(
      'No reading yet: the monitor did not answer the last 5 tries. It is asked again every 10 minutes.',
    );
  });

  it('never read and stale (unknown): the tries counted and the backoff’s true bound', () => {
    expect(noReadingLine(at(THRESHOLDS.staleAfter))).toBe(
      'No reading yet: the monitor did not answer the last 6 tries. It is asked less often now, at least once every 8 hours; Check now asks at once.',
    );
    expect(noReadingLine(at(40))).toContain('the last 40 tries');
  });

  it('no line makes a claim a state does not keep', () => {
    for (const n of [0, 1, 5, 6, 7, 500]) {
      for (const line of [noReadingLine(at(n)), noReadingLine(at(n, true, null))]) {
        for (const claim of FALSE_CLAIMS) expect(line).not.toMatch(claim);
        expect(line).not.toMatch(/[\u2013\u2014]/);
      }
    }
  });
});

describe('failedReadLine: the note above an older reading', () => {
  const okAt = '2026-10-15T11:00:00Z';

  it('none when the last try answered', () => {
    expect(failedReadLine(null, NOW)).toBeNull();
    expect(failedReadLine(at(0, true, okAt), NOW)).toBeNull();
  });

  it('failing but not stale: the tries, the pace, the last reading', () => {
    expect(failedReadLine(at(2, false, okAt), NOW)).toBe(
      'The monitor did not answer the last 2 tries. It is asked again every 10 minutes. Last reading 1 h ago.',
    );
  });

  it('stale (unknown) over an older reading: the backoff’s true bound, not "just now"', () => {
    expect(failedReadLine(at(9, false, '2026-10-15T04:00:00Z'), NOW)).toBe(
      'The monitor did not answer the last 9 tries. It is asked less often now, at least once every 8 hours; Check now asks at once. Last reading 8 h ago.',
    );
  });

  it('no note makes a claim a state does not keep', () => {
    for (const n of [1, 5, 6, 7, 500]) {
      const line = failedReadLine(at(n, false, okAt), NOW) ?? '';
      for (const claim of FALSE_CLAIMS) expect(line).not.toMatch(claim);
      expect(line).not.toMatch(/[\u2013\u2014]/);
    }
  });
});

describe('STALE_RETRY_HOURS', () => {
  it('covers the longest wait the runner can make once stale, and not by a needless hour', () => {
    // The capped backoff at its highest jitter, then up to one run of the 10-minute schedule.
    const longest = TIMING.backoffCapMs * (1 + TIMING.backoffJitter) + 10 * MINUTE;
    expect(STALE_RETRY_HOURS * HOUR).toBeGreaterThanOrEqual(longest);
    expect((STALE_RETRY_HOURS - 1) * HOUR).toBeLessThan(longest);
  });

  it('before stale, a failed read is tried again within one run of the schedule', () => {
    expect(TIMING.retryMs).toBeLessThanOrEqual(10 * MINUTE);
  });
});
